// In-process end to end: fake mint (HTTP) + real mock-api server + real wallet + agent.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { VAULT_IDL, USDC_DEVNET_MINT, configPda, vaultAta, type ProviderInfo } from "@blindfold/protocol";
import { makeProviderKey } from "@blindfold/testkit";
import { AgentWallet, ownerFund } from "@blindfold/wallet";
import { fakeVaultToken } from "../../../packages/wallet/test/fakes/fake-vault-token.js";
import { FakeDepositor } from "../../../packages/wallet/test/fakes/fake-depositor.js";
import { FakeMint } from "../../../packages/wallet/test/fakes/fake-mint.js";
import { FakeProvider } from "../../../packages/wallet/test/fakes/fake-provider.js";
import { createApp } from "../../../apps/mock-api/src/app.js";
import { runMain } from "../src/main.js";
import { runLlm, type Chat } from "../src/llm.js";
import { makeTools } from "../src/tools.js";

const providerKey = makeProviderKey();
const otherKey = makeProviderKey();
const programId = Keypair.generate().publicKey;
const usdcMint = new PublicKey(USDC_DEVNET_MINT);
const dir = mkdtempSync(join(tmpdir(), "bf-e2e-"));
let fundedJson = "";

async function configData() {
  const k = () => Keypair.generate().publicKey;
  return new BorshAccountsCoder(VAULT_IDL).encode("Config", {
    admin: k(), mint_authority: k(), usdc_mint: usdcMint, vault_token: vaultAta(usdcMint, programId),
    max_deposit: new BN(1), deposit_count: new BN(0), provider_count: 0, last_batch_id: new BN(0), bump: 1,
  });
}
const connection = (vaultCents: number | "rpc_error") => ({
  async getMultipleAccountsInfo() {
    if (vaultCents === "rpc_error") throw new Error("rpc down");
    return [{ owner: programId, data: await configData() }, fakeVaultToken(usdcMint, configPda(programId), BigInt(vaultCents) * 10_000n), null];
  },
});

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops.splice(0)) await s(); });

async function world() {
  const mint = new FakeMint();
  const mintUrl = await mint.start();
  stops.push(() => mint.stop());
  const logs: Record<string, unknown>[] = [];
  const app = createApp({ mintUrl, providerSecretKey: providerKey.sk, priceCents: 5, log: (e) => logs.push(e) });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 50));
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stops.push(() => new Promise<void>((r) => { (server as any).closeAllConnections?.(); server.close(() => r()); }));
  const providers: ProviderInfo[] = [
    { provider_id: 0, pubkey: providerKey.pubkey, name: "mock-api", url: apiUrl, price_cents: 5, topics: ["sol", "btc"], active: true },
    { provider_id: 1, pubkey: otherKey.pubkey, name: "other", url: "http://127.0.0.1:1", price_cents: 5, topics: ["eth"], active: true },
  ];
  mint.setProviders(providers);
  mint.reserves.outstanding = 50;
  const tokenFile = join(mkdtempSync(join(dir, "w-")), "tokens.json");
  const f = JSON.parse(fundedJson);
  f.mint = mintUrl;
  writeFileSync(tokenFile, JSON.stringify(f));
  const env = (extra: Record<string, string> = {}) => ({
    TOKEN_FILE: tokenFile, MINT_URL: mintUrl, SOLANA_RPC_URL: "http://rpc.invalid", VAULT_PROGRAM_ID: programId.toBase58(),
    USDC_MINT: USDC_DEVNET_MINT, ...extra,
  });
  const agent = async (argv: string[], vault: number | "rpc_error" = 100, extra: Record<string, string> = {}) => {
    let stdout = "", stderr = "";
    const code = await runMain(["--json", ...argv], env(extra), { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, { connection: connection(vault) as never });
    return { code, stdout, stderr };
  };
  const balance = () => JSON.parse(readFileSync(tokenFile, "utf8")).proofs.reduce((s: number, p: { amount: number }) => s + p.amount, 0) as number;
  return { mint, mintUrl, logs, apiUrl, tokenFile, agent, balance, providers };
}

beforeAll(async () => {
  // Real owner flow once (blind issuance is slow); each test copies the result.
  const mint = new FakeMint();
  const mintUrl = await mint.start();
  mint.setProviders([
    { provider_id: 0, pubkey: providerKey.pubkey, name: "mock-api", url: null, price_cents: 5, topics: [], active: true },
    { provider_id: 1, pubkey: otherKey.pubkey, name: "other", url: null, price_cents: 5, topics: [], active: true },
  ]);
  const tokenFile = join(dir, "funded.json");
  await ownerFund({ mintUrl, cents: 100, tokenFile, depositor: new FakeDepositor(mint), stateDir: join(dir, "state"), pollMs: 5 });
  fundedJson = readFileSync(tokenFile, "utf8");
  await mint.stop();
  copyFileSync(tokenFile, join(dir, "unused.json"));
});
afterAll(() => undefined);

describe("in-process e2e", () => {
  it("paid call: 200, one JSON line, balance drops by the price, provider credited at the mint", async () => {
    const w = await world();
    const r = await w.agent(["--topic", "sol"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const j = JSON.parse(r.stdout);
    expect(j.provider.name).toBe("mock-api");
    expect(j.calls[0]).toMatchObject({ status: 200, paidCents: 5 });
    expect(j.calls[0].data.topic).toBe("sol");
    expect(j.calls[0].redemptionId).toBeTruthy();
    expect(j.balanceBefore - j.balanceAfter).toBe(5);
    expect(w.balance()).toBe(95);
    expect(w.mint.redeemer.balances.get(0)).toBe(5);
    expect(j.reserves).toMatchObject({ ok: true, vaultCents: 100, outstandingCents: 50 });
  });

  it("replay of the PAYMENT-SIGNATURE is rejected (402, redeem_failed_11001), mint balance unchanged", async () => {
    const w = await world();
    let header = "";
    const spy: typeof fetch = async (i, init) => {
      const h = new Request(i as Request, init).headers.get("payment-signature");
      if (h) header = h;
      return fetch(i, init);
    };
    const wallet = await AgentWallet.open({ tokenFile: w.tokenFile, maxPerCallCents: 10, fetch: spy });
    stops.push(async () => wallet.close());
    expect((await wallet.payFetch(`${w.apiUrl}/v1/data/sol`)).status).toBe(200);
    const r = await fetch(`${w.apiUrl}/v1/data/sol`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(r.status).toBe(402);
    expect(w.logs.some((l) => l.outcome === "rejected:redeem_failed_11001")).toBe(true);
    expect(w.mint.redeemer.balances.get(0)).toBe(5);
  });

  it("evil provider is refused client-side, nothing leaves the wallet", async () => {
    const w = await world();
    const evil = new FakeProvider({ sk: makeProviderKey().sk, mintUrl: w.mintUrl, spend: () => undefined, mode: "hostile", attackerKey: makeProviderKey().pubkey, keysetIds: [w.mint.keyset.id] });
    await evil.start();
    stops.push(() => evil.stop());
    w.mint.setProviders([{ provider_id: 0, pubkey: providerKey.pubkey, name: "evil", url: evil.url, price_cents: 5, topics: ["sol"], active: true }]);
    const r = await w.agent(["--provider", "evil"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error).toMatchObject({ kind: "payment_refused", reason: "provider_not_allowed" });
    expect(evil.paidRequests).toBe(0);
    expect(w.balance()).toBe(100);
  });

  it("over-cap is refused before any proof leaves", async () => {
    const w = await world();
    const r = await w.agent(["--max-per-call", "3"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.reason).toBe("over_cap");
    expect(w.mint.redeemCalls).toBe(0);
    expect(w.balance()).toBe(100);
  });

  it("reserve check fails closed: vault below outstanding, and RPC error", async () => {
    const w = await world();
    let r = await w.agent([], 10);
    expect(r.code).toBe(7);
    expect(JSON.parse(r.stdout).error.kind).toBe("reserves_failed");
    r = await w.agent([], "rpc_error");
    expect(r.code).toBe(7);
    expect(w.mint.redeemCalls).toBe(0);
    expect(w.balance()).toBe(100);
  });

  it("several calls drain the exact price each time", async () => {
    const w = await world();
    const r = await w.agent(["--calls", "3", "--topic", "btc"]);
    expect(r.code).toBe(0);
    expect(w.balance()).toBe(85);
    expect(w.mint.redeemer.balances.get(0)).toBe(15);
  });

  it("LLM loop: the wallet refuses an offer larger than the budget left, before any proof leaves", async () => {
    const w = await world();
    const wallet = await AgentWallet.open({ tokenFile: w.tokenFile, maxPerCallCents: 30, usdcMint: USDC_DEVNET_MINT });
    try {
      const tools = makeTools({
        wallet, mintUrl: w.mintUrl, connection: connection(100) as never, programId, usdcMint,
        out: { log: () => undefined, result: () => undefined, error: () => undefined },
      });
      const url = `${w.apiUrl}/v1/data/sol`;
      let i = 0;
      const chat: Chat = async () => i++ < 3
        ? { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "buy_data", arguments: JSON.stringify({ url }) } }] }
        : { role: "assistant", content: "HOLD, done" };
      // Budget 7, price 5: after one purchase 2 cents are left, so the second 5-cent offer must be refused.
      const r = await runLlm(tools, { goal: "g", chat, budgetCents: 7, reserveEvery: 10 });
      expect(r.steps.filter((s) => s.tool === "buy_data").map((s) => [s.outcome, s.reason])).toEqual([
        ["ok", undefined], ["refused", "budget_exhausted"], ["refused", "budget_exhausted"],
      ]);
      expect(r.paidCents).toBe(5);
      expect(w.balance()).toBe(95);
      expect(w.mint.redeemCalls).toBe(1);
    } finally {
      wallet.close();
    }
  });
});
