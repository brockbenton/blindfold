// Real mint (fake-chain mode, Postgres) + real mock API + real owner flow + real agent. Skips without DATABASE_URL.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USDC_DEVNET_MINT, VAULT_IDL, vaultAta } from "@blindfold/protocol";
import { makeProviderKey } from "@blindfold/testkit";
import { AgentWallet, PaymentRefused, ownerFund, type Depositor } from "@blindfold/wallet";
import { FakeSender, MemoryVault } from "../../../services/mint/src/chain/memory.js";
import { createPool } from "../../../services/mint/src/db.js";
import { createMint } from "../../../services/mint/src/mint.js";
import type { AppConfig } from "../../../services/mint/src/config.js";
import { createApp } from "../../../apps/mock-api/src/app.js";
import { HttpRedeemClient } from "../../../apps/mock-api/src/x402/redeemClient.js";
import { runMain } from "../../../agents/simple/src/main.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN = "integration-admin";
const PRICE = 5;
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

describe.skipIf(!DATABASE_URL)("real mint + mock API + owner + agent", () => {
  const providerKey = makeProviderKey();
  const programId = Keypair.generate().publicKey;
  const usdc = new PublicKey(USDC_DEVNET_MINT);
  const dir = mkdtempSync(join(tmpdir(), "bf-int-"));
  const tokenFile = join(dir, "tokens.json");
  const schema = `int_${randomBytes(6).toString("hex")}`;
  const stops: (() => Promise<void> | void)[] = [];
  const apiLogs: Record<string, unknown>[] = [];
  let mintUrl = "", apiUrl = "";
  let vault: MemoryVault;
  let payoutToken = "";

  const mintReq = async (path: string, body?: unknown, auth = false) => {
    const r = await fetch(mintUrl + path, {
      method: body === undefined && !path.endsWith("/settle") ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${ADMIN}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const providerBalance = async () => {
    const r = await mintReq("/v1/blindfold/admin/balances", undefined, true);
    return (r.json as { provider_id: number; balance: number }[]).find((b) => b.provider_id === 0)?.balance ?? 0;
  };
  const walletCents = () =>
    (JSON.parse(readFileSync(tokenFile, "utf8")).proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0);

  async function configData() {
    const k = () => Keypair.generate().publicKey;
    return new BorshAccountsCoder(VAULT_IDL).encode("Config", {
      admin: k(), mint_authority: k(), usdc_mint: usdc, vault_token: vaultAta(usdc, programId),
      max_deposit: new BN(1), deposit_count: new BN(0), provider_count: 0, last_batch_id: new BN(0), bump: 1,
    });
  }
  /** Fake Solana connection: vault balance is read from the mint's in-memory vault unless overridden. */
  const connection = (override?: { vaultCents: number }) => ({
    async getAccountInfo() { return { owner: programId, data: await configData() }; },
    async getTokenAccountBalance() {
      const base = override ? BigInt(override.vaultCents) * 10_000n : vault.balanceBase;
      return { value: { amount: base.toString() } };
    },
  });
  const agent = async (argv: string[], conn = connection()) => {
    let stdout = "", stderr = "";
    const code = await runMain(
      ["--json", ...argv],
      { TOKEN_FILE: tokenFile, MINT_URL: mintUrl, SOLANA_RPC_URL: "http://rpc.invalid", VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: USDC_DEVNET_MINT },
      { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) },
      { connection: conn as never },
    );
    return { code, stdout, stderr };
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`create schema ${schema}`);
    const db = createPool(DATABASE_URL!, schema);
    stops.push(async () => { await db.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });

    const [mintPort, apiPort] = [await freePort(), await freePort()];
    mintUrl = `http://127.0.0.1:${mintPort}`;
    apiUrl = `http://127.0.0.1:${apiPort}`;
    vault = new MemoryVault();
    const cfg: AppConfig = {
      SOLANA_RPC_URL: "http://127.0.0.1:8899", VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: USDC_DEVNET_MINT,
      MINT_URL: mintUrl, DATABASE_URL: DATABASE_URL!, MINT_SEED: "09".repeat(32), MINT_AUTHORITY_KEYPAIR: "",
      MINT_ADMIN_TOKEN: ADMIN, PORT: mintPort,
      providers: [{ provider_id: 0, name: "mock-api", url: apiUrl, price_cents: PRICE, topics: ["sol", "btc"] }],
      depositPollMs: 1e9, settleIntervalS: 1e9, devFakeChain: true,
    };
    const { app } = await createMint({ db, cfg, vault, sender: new FakeSender(vault), devVault: vault });
    const ms = serve({ fetch: app.fetch, port: mintPort, hostname: "127.0.0.1" });
    stops.push(() => new Promise<void>((r) => { (ms as any).closeAllConnections?.(); ms.close(() => r()); }));

    // Register the mock API's key as provider 0 (as the vault admin would onchain).
    const reg = await mintReq("/dev/provider", { cashu_pubkey: providerKey.pubkey }, true);
    expect(reg.status).toBe(200);
    payoutToken = reg.json.payout_token;

    const api = createApp({
      mintUrl, providerSecretKey: providerKey.sk, priceCents: PRICE, providerId: 0,
      redeem: new HttpRedeemClient(mintUrl), log: (e) => apiLogs.push(e),
    });
    const as = serve({ fetch: api.fetch, port: apiPort, hostname: "127.0.0.1" });
    stops.push(() => new Promise<void>((r) => { (as as any).closeAllConnections?.(); as.close(() => r()); }));

    // Real owner flow; the depositor calls the mint's /dev/deposit instead of Solana.
    const depositor: Depositor = {
      async deposit({ amountCents, depositRef }) {
        const r = await mintReq("/dev/deposit", { deposit_ref: Buffer.from(depositRef).toString("hex"), amount_cents: amountCents }, true);
        if (r.status !== 200) throw new Error(`dev deposit failed: ${JSON.stringify(r.json)}`);
        return { signature: `dev-${r.json.index}` };
      },
    };
    await ownerFund({ mintUrl, cents: 100, tokenFile, depositor, stateDir: join(dir, "state"), pollMs: 20 });
  });
  afterAll(async () => { for (const s of stops.reverse()) await s(); });

  it("owner funded a token file locked to the registered provider", () => {
    expect(walletCents()).toBe(100);
    const f = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(f.proofs.every((p: { secret: string }) => p.secret.includes(providerKey.pubkey))).toBe(true);
  });

  it("reserves after issuance: issued 100, settled 0, outstanding 100", async () => {
    const r = await mintReq("/v1/blindfold/reserves");
    expect(r.json).toMatchObject({ issued: 100, settled: 0, outstanding: 100 });
  });

  let header = "";
  it("paid call: 200 with a redemption id in PAYMENT-RESPONSE; replay of the signature is 402 with balance unchanged", async () => {
    const spy: typeof fetch = async (i, init) => {
      const h = new Request(i as Request, init).headers.get("payment-signature");
      if (h) header = h;
      return fetch(i, init);
    };
    const wallet = await AgentWallet.open({ tokenFile, maxPerCallCents: 10, usdcMint: USDC_DEVNET_MINT, fetch: spy });
    try {
      const res = await wallet.payFetch(`${apiUrl}/v1/data/sol`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { topic: string }).topic).toBe("sol");
      const pr = JSON.parse(Buffer.from(res.headers.get("payment-response")!, "base64").toString());
      expect(pr.success).toBe(true);
      expect(pr.transaction).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      wallet.close();
    }
    expect(walletCents()).toBe(100 - PRICE);
    expect(await providerBalance()).toBe(PRICE);

    const replay = await fetch(`${apiUrl}/v1/data/sol`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    expect(apiLogs.some((l) => l.outcome === "rejected:redeem_failed_11001")).toBe(true);
    expect(await providerBalance()).toBe(PRICE);
  });

  it("agent run through the real stack passes the reserve check and pays", async () => {
    const r = await agent(["--topic", "btc"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.calls[0]).toMatchObject({ status: 200, paidCents: PRICE });
    expect(j.reserves).toMatchObject({ ok: true, vaultCents: 100, outstandingCents: 100 });
    expect(walletCents()).toBe(100 - 2 * PRICE);
    expect(await providerBalance()).toBe(2 * PRICE);
  });

  it("over-cap is refused before any proof leaves", async () => {
    const before = walletCents();
    const r = await agent(["--max-per-call", "3"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.reason).toBe("over_cap");
    expect(walletCents()).toBe(before);
    expect(await providerBalance()).toBe(2 * PRICE);
  });

  it("evil provider (a different key than the allowlist) is refused before any proof leaves", async () => {
    const evilKey = makeProviderKey();
    const evil = serve({ fetch: createApp({ mintUrl, providerSecretKey: evilKey.sk, priceCents: PRICE, redeem: new HttpRedeemClient(mintUrl), log: () => undefined }).fetch, port: 0, hostname: "127.0.0.1" });
    stops.push(() => new Promise<void>((r) => { (evil as any).closeAllConnections?.(); evil.close(() => r()); }));
    await new Promise((r) => setTimeout(r, 30));
    const url = `http://127.0.0.1:${(evil.address() as { port: number }).port}/v1/data/sol`;
    const wallet = await AgentWallet.open({ tokenFile, maxPerCallCents: 10, usdcMint: USDC_DEVNET_MINT });
    const before = walletCents();
    try {
      await expect(wallet.payFetch(url)).rejects.toBeInstanceOf(PaymentRefused);
    } finally {
      wallet.close();
    }
    expect(walletCents()).toBe(before);
    expect(await providerBalance()).toBe(2 * PRICE);
  });

  it("reserve check fails closed when the vault holds less than outstanding", async () => {
    const before = walletCents();
    const r = await agent([], connection({ vaultCents: 10 }));
    expect(r.code).toBe(7);
    expect(JSON.parse(r.stdout).error.kind).toBe("reserves_failed");
    expect(walletCents()).toBe(before);
  });

  it("admin settle pays the right amount, reserves and reconcile stay consistent", async () => {
    const s = await mintReq("/v1/blindfold/admin/settle", {}, true);
    expect(s.status).toBe(200);
    expect(s.json.payouts).toEqual([{ provider_id: 0, amount: 2 * PRICE }]);
    expect(vault.paid.get(0)).toBe(BigInt(2 * PRICE) * 10_000n);
    expect(payoutToken).toBeTruthy();
    expect(await providerBalance()).toBe(0);

    const rec = (await mintReq("/v1/blindfold/admin/reconcile", undefined, true)).json;
    expect(rec).toMatchObject({ deposited: 100, issued: 100, redeemed: 2 * PRICE, settled: 2 * PRICE });
    expect(rec.vault_balance).toBe(rec.deposited - rec.settled);

    const res = (await mintReq("/v1/blindfold/reserves")).json;
    expect(res).toMatchObject({ issued: 100, settled: 2 * PRICE, outstanding: 100 - 2 * PRICE });
    // The agent still passes against the true vault balance.
    expect((await agent(["--topic", "sol"])).code).toBe(0);
  });

  it("seams: uppercase provider key onchain is served lowercase; trailing-slash mint URLs work end to end", async () => {
    const other = makeProviderKey();
    const reg = await mintReq("/dev/provider", { cashu_pubkey: other.pubkey.toUpperCase() }, true);
    expect(reg.status).toBe(200);
    const list = (await mintReq("/v1/blindfold/providers")).json as { pubkey: string }[];
    expect(list.map((p) => p.pubkey)).toContain(other.pubkey);
    expect(list.every((p) => p.pubkey === p.pubkey.toLowerCase())).toBe(true);

    const slash = `${mintUrl}/`;
    const file2 = join(dir, "tokens2.json");
    const depositor: Depositor = {
      async deposit({ amountCents, depositRef }) {
        const r = await mintReq("/dev/deposit", { deposit_ref: Buffer.from(depositRef).toString("hex"), amount_cents: amountCents }, true);
        return { signature: `dev-${r.json.index}` };
      },
    };
    await ownerFund({ mintUrl: slash, cents: 20, tokenFile: file2, depositor, stateDir: join(dir, "state2"), pollMs: 20 });
    const api2 = serve({
      fetch: createApp({ mintUrl: slash, providerSecretKey: providerKey.sk, priceCents: PRICE, redeem: new HttpRedeemClient(slash), log: () => undefined }).fetch,
      port: 0, hostname: "127.0.0.1",
    });
    stops.push(() => new Promise<void>((r) => { (api2 as any).closeAllConnections?.(); api2.close(() => r()); }));
    await new Promise((r) => setTimeout(r, 30));
    const wallet = await AgentWallet.open({ tokenFile: file2, maxPerCallCents: 10, usdcMint: USDC_DEVNET_MINT });
    try {
      const res = await wallet.payFetch(`http://127.0.0.1:${(api2.address() as { port: number }).port}/v1/data/eth`);
      expect(res.status).toBe(200);
    } finally {
      wallet.close();
    }
    expect(wallet.balance()).toBe(20 - PRICE);
  });
});
