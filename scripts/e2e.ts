// 00 section 10 end to end on a real vault: owner deposit -> mint -> agent paid call -> replay -> settle -> reconcile -> reserve check.
//
//   pnpm --filter @blindfold/scripts e2e:localnet      spawns solana-test-validator with target/deploy/vault.so (build with `anchor build`)
//   pnpm --filter @blindfold/scripts e2e               devnet (vault deployed and funded keys required)
//
// devnet env (all required unless noted):
//   ADMIN_KEYPAIR           path; pays for provider setup, initializes the vault if absent (needs devnet SOL)
//   OWNER_KEYPAIR           path; needs devnet SOL and at least 1 USDC (faucet.circle.com) in its ATA
//   MINT_AUTHORITY_KEYPAIR  path; signs settle_batch; must equal Config.mint_authority (needs devnet SOL)
//   SOLANA_RPC_URL          default https://api.devnet.solana.com
//   VAULT_PROGRAM_ID, USDC_MINT   default: the protocol constants
//   DATABASE_URL            Postgres; a throwaway schema is created and dropped
// Run with --keep-validator to leave the localnet validator running.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DEFAULT_VAULT_PROGRAM_ID, MAX_DEPOSIT_CENTS, SOLANA_COMMITMENT, USDC_DEVNET_MINT, buildInitializeIx,
  buildRegisterProviderIx, centsToBaseUnits, configPda, decodeConfig, vaultAta,
} from "@blindfold/protocol";
import { AgentWallet, SolanaDepositor, ownerFund } from "@blindfold/wallet";
import { createApp } from "../apps/mock-api/src/app.js";
import { HttpRedeemClient } from "../apps/mock-api/src/x402/redeemClient.js";
import { SolanaSettleSender } from "../services/mint/src/chain/settleSender.js";
import { SolanaVaultReader } from "../services/mint/src/chain/vaultReader.js";
import type { AppConfig } from "../services/mint/src/config.js";
import { createPool } from "../services/mint/src/db.js";
import { createMint as createMintServer } from "../services/mint/src/mint.js";
import { runMain } from "../agents/simple/src/main.js";
import { getPubKeyFromPrivKey, createRandomSecretKey } from "@cashu/cashu-ts";

const localnet = process.argv.includes("--localnet");
const keepValidator = process.argv.includes("--keep-validator");
const PRICE = 5;
const DEPOSIT_CENTS = 100;
const ADMIN_TOKEN = "e2e-admin-token";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const solanaBin = `${homedir()}/.local/share/solana/install/active_release/bin`;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) throw new Error(`FAIL ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  log(`  ok   ${name}`);
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (see the header of scripts/e2e.ts)`);
  return v;
}
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const cleanups: (() => Promise<void> | void)[] = [];
let validator: ChildProcess | undefined;

async function tokenBalance(c: Connection, ata: PublicKey): Promise<bigint> {
  return BigInt((await c.getTokenAccountBalance(ata, SOLANA_COMMITMENT)).value.amount);
}
async function airdrop(c: Connection, to: PublicKey, sol: number) {
  const sig = await c.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const bh = await c.getLatestBlockhash();
  await c.confirmTransaction({ signature: sig, ...bh }, SOLANA_COMMITMENT);
}

async function startValidator(rpc: string, programId: PublicKey): Promise<void> {
  const so = join(ROOT, "target/deploy/vault.so");
  if (!existsSync(so)) throw new Error(`${so} missing: run \`anchor build\` first`);
  const c = new Connection(rpc, SOLANA_COMMITMENT);
  if (await c.getVersion().then(() => true, () => false)) {
    log("using the validator already running on " + rpc);
    return;
  }
  const ledger = mkdtempSync(join(tmpdir(), "bf-ledger-"));
  validator = spawn(`${solanaBin}/solana-test-validator`, ["--bpf-program", programId.toBase58(), so, "--ledger", ledger, "--reset", "--quiet"], {
    stdio: "ignore", env: { ...process.env, PATH: `${solanaBin}:${process.env.PATH}` },
  });
  validator.on("exit", (code) => { if (code) console.error(`validator exited with ${code}`); });
  if (!keepValidator) cleanups.push(() => { validator?.kill("SIGTERM"); });
  for (let i = 0; i < 90; i++) {
    if (await c.getVersion().then(() => true, () => false)) return;
    await sleep(1000);
  }
  throw new Error("solana-test-validator did not come up in 90s");
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? (localnet ? "http://127.0.0.1:8899" : "https://api.devnet.solana.com");
  if (/mainnet/i.test(rpc)) throw new Error("refusing to run against mainnet");
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required (e.g. postgres://dragonite@127.0.0.1:54329/blindfold from services/mint/scripts/dev-pg.sh)");

  log(`mode: ${localnet ? "localnet" : "devnet"}  rpc: ${rpc}  program: ${programId.toBase58()}`);
  if (localnet) await startValidator(rpc, programId);
  const connection = new Connection(rpc, SOLANA_COMMITMENT);

  // Keys and USDC.
  let admin: Keypair, owner: Keypair, authority: Keypair, usdcMint: PublicKey;
  if (localnet) {
    [admin, owner, authority] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const k of [admin, owner, authority]) await airdrop(connection, k.publicKey, 10);
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, owner.publicKey);
    await mintTo(connection, admin, usdcMint, ata.address, admin, 100_000_000n);
    log(`localnet USDC mint ${usdcMint.toBase58()}`);
  } else {
    admin = loadKeypair(need("ADMIN_KEYPAIR"));
    owner = loadKeypair(need("OWNER_KEYPAIR"));
    authority = loadKeypair(need("MINT_AUTHORITY_KEYPAIR"));
    usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
    for (const [name, k] of [["ADMIN_KEYPAIR", admin], ["OWNER_KEYPAIR", owner], ["MINT_AUTHORITY_KEYPAIR", authority]] as const) {
      if ((await connection.getBalance(k.publicKey)) < 0.05 * LAMPORTS_PER_SOL) throw new Error(`${name} ${k.publicKey.toBase58()} needs devnet SOL (try \`solana airdrop 2 <pubkey> --url devnet\`)`);
    }
    const ownerAta = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
    const have = await tokenBalance(connection, ownerAta).catch(() => 0n);
    if (have < centsToBaseUnits(DEPOSIT_CENTS)) throw new Error(`owner ${owner.publicKey.toBase58()} needs >= ${DEPOSIT_CENTS / 100} USDC in ${ownerAta.toBase58()} (faucet.circle.com)`);
    if (!(await connection.getAccountInfo(programId))) throw new Error(`vault program ${programId.toBase58()} is not deployed on ${rpc}`);
  }

  // Vault: initialize if needed, register a fresh provider with its own payout account.
  const send = (ixs: TransactionInstruction[], signers: Keypair[]) =>
    sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: SOLANA_COMMITMENT });
  if (!(await connection.getAccountInfo(configPda(programId)))) {
    await send([buildInitializeIx({ programId, admin: admin.publicKey, usdcMint, mintAuthority: authority.publicKey, maxDeposit: centsToBaseUnits(MAX_DEPOSIT_CENTS) })], [admin]);
    log("vault initialized");
  }
  const config = decodeConfig((await connection.getAccountInfo(configPda(programId)))!.data);
  check("Config.mint_authority matches MINT_AUTHORITY_KEYPAIR", config.mintAuthority.equals(authority.publicKey));
  check("Config.usdc_mint matches", config.usdcMint.equals(usdcMint));
  const providerSk = createRandomSecretKey();
  const providerPubkey = hex(getPubKeyFromPrivKey(providerSk));
  const payoutOwner = Keypair.generate();
  const payoutAta = (await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, payoutOwner.publicKey)).address;
  const providerId = config.providerCount;
  await send([buildRegisterProviderIx({ programId, admin: admin.publicKey, providerId, cashuPubkey: providerPubkey, payoutToken: payoutAta })], [admin]);
  log(`provider ${providerId} registered (${providerPubkey.slice(0, 12)}...)`);
  const vaultToken = vaultAta(usdcMint, programId);
  const vaultBefore = await tokenBalance(connection, vaultToken).catch(() => 0n);

  // Mint (in process): real Solana reader and sender, throwaway Postgres schema.
  const schema = `e2e_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  await adminPool.query(`create schema ${schema}`);
  const db = createPool(databaseUrl, schema);
  cleanups.push(async () => { await db.end(); await adminPool.query(`drop schema ${schema} cascade`); await adminPool.end(); });
  const [mintPort, apiPort] = [await freePort(), await freePort()];
  const mintUrl = `http://127.0.0.1:${mintPort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const cfg: AppConfig = {
    SOLANA_RPC_URL: rpc, VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: usdcMint.toBase58(), MINT_URL: mintUrl,
    DATABASE_URL: databaseUrl, MINT_SEED: randomBytes(32).toString("hex"), MINT_AUTHORITY_KEYPAIR: "", MINT_ADMIN_TOKEN: ADMIN_TOKEN, PORT: mintPort,
    providers: [{ provider_id: providerId, name: "mock-api", url: apiUrl, price_cents: PRICE, topics: ["sol", "btc", "eth"] }],
    depositPollMs: 1000, settleIntervalS: 1e9, devFakeChain: false,
  };
  const { app: mintApp, start } = await createMintServer({
    db, cfg, vault: new SolanaVaultReader(connection, programId, usdcMint),
    sender: new SolanaSettleSender(connection, programId, usdcMint, authority), confirmTimeoutMs: 60_000,
  });
  cleanups.push(start());
  const stop = (s: ReturnType<typeof serve>) => new Promise<void>((r) => { (s as any).closeAllConnections?.(); s.close(() => r()); });
  const mintServer = serve({ fetch: mintApp.fetch, port: mintPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(mintServer));
  const mintReq = async (path: string, init: { body?: unknown; auth?: boolean } = {}) => {
    const r = await fetch(mintUrl + path, {
      method: init.body !== undefined ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(init.auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  // Mock API (in process) with the real redeem client.
  const apiLogs: Record<string, unknown>[] = [];
  const api = createApp({ mintUrl, providerSecretKey: hex(providerSk), priceCents: PRICE, providerId, redeem: new HttpRedeemClient(mintUrl), log: (e) => apiLogs.push(e) });
  const apiServer = serve({ fetch: api.fetch, port: apiPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(apiServer));

  const dir = mkdtempSync(join(tmpdir(), "bf-e2e-"));
  const tokenFile = join(dir, "tokens.json");
  const walletCents = () => (JSON.parse(readFileSync(tokenFile, "utf8")).proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0);
  const providerBalance = async () =>
    ((await mintReq("/v1/blindfold/admin/balances", { auth: true })).json as { provider_id: number; balance: number }[]).find((b) => b.provider_id === providerId)?.balance ?? 0;
  const agentEnv = (url = mintUrl) => ({
    TOKEN_FILE: tokenFile, MINT_URL: url, SOLANA_RPC_URL: rpc, VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: usdcMint.toBase58(),
  });
  const agent = async (argv: string[], url?: string) => {
    let stdout = "";
    const code = await runMain(["--json", ...argv], agentEnv(url), { stdout: (s) => (stdout += s), stderr: () => undefined });
    return { code, out: JSON.parse(stdout) as any };
  };

  // 1. Owner: quote, deposit, wait paid, mint locked tokens, write the token file.
  log("1. owner funds the token file");
  const depositor = new SolanaDepositor({ rpcUrl: rpc, owner, programId, usdcMint });
  const funded = await ownerFund({
    mintUrl, cents: DEPOSIT_CENTS, tokenFile, depositor, stateDir: join(dir, "owner"), pollMs: 1000, timeoutMs: 120_000,
    onProgress: (s) => log(`     step: ${s}`),
  });
  check("deposit tx recorded", funded.depositTx.length > 20, funded);
  check("token file holds the deposit", walletCents() === DEPOSIT_CENTS, walletCents());
  check("vault balance rose by the deposit", (await tokenBalance(connection, vaultToken)) - vaultBefore === centsToBaseUnits(DEPOSIT_CENTS));

  // 2. Agent: reserve check passes, paid call succeeds.
  log("2. agent paid call");
  const r1 = await agent(["--topic", "sol"]);
  check("agent exit 0", r1.code === 0, r1.out);
  check("reserve check ok", r1.out.reserves?.ok === true, r1.out.reserves);
  check("status 200 with a redemption id", r1.out.calls[0].status === 200 && !!r1.out.calls[0].redemptionId, r1.out.calls[0]);
  check("balance dropped by the price", walletCents() === DEPOSIT_CENTS - PRICE);
  check("provider credited at the mint", (await providerBalance()) === PRICE);

  // 3. Replay of a captured PAYMENT-SIGNATURE.
  log("3. replay");
  let header = "";
  const spy: typeof fetch = async (i, init) => {
    const h = new Request(i as Request, init).headers.get("payment-signature");
    if (h) header = h;
    return fetch(i, init);
  };
  const wallet = await AgentWallet.open({ tokenFile, maxPerCallCents: 10, usdcMint: usdcMint.toBase58(), fetch: spy });
  try {
    check("second paid call 200", (await wallet.payFetch(`${apiUrl}/v1/data/btc`)).status === 200);
  } finally {
    wallet.close();
  }
  check("provider balance is 2 prices", (await providerBalance()) === 2 * PRICE);
  const replay = await fetch(`${apiUrl}/v1/data/btc`, { headers: { "PAYMENT-SIGNATURE": header } });
  check("replay is 402", replay.status === 402, replay.status);
  check("provider logged redeem_failed_11001", apiLogs.some((l) => l.outcome === "rejected:redeem_failed_11001"));
  check("mint balance unchanged by replay", (await providerBalance()) === 2 * PRICE);

  // 4. Settle for real.
  log("4. admin settle");
  const payoutBefore = await tokenBalance(connection, payoutAta);
  const s = await mintReq("/v1/blindfold/admin/settle", { body: {}, auth: true });
  check("settle 200 with a tx", s.status === 200 && typeof s.json.tx === "string", s);
  check("payout is the owed amount", s.json.payouts.length === 1 && s.json.payouts[0].provider_id === providerId && s.json.payouts[0].amount === 2 * PRICE, s.json.payouts);
  const paid = (await tokenBalance(connection, payoutAta)) - payoutBefore;
  check("provider payout account received base units", paid === centsToBaseUnits(2 * PRICE), paid.toString());

  // 5. Reconcile.
  log("5. reconcile");
  const rec = (await mintReq("/v1/blindfold/admin/reconcile", { auth: true })).json;
  const vaultNow = await tokenBalance(connection, vaultToken);
  check("mint view: vault_balance == deposited - settled (this run's schema)", vaultBefore !== 0n || rec.vault_balance === rec.deposited - rec.settled, rec);
  check("vault delta == deposited_this_run - settled", Number((vaultNow - vaultBefore) / 10_000n) === DEPOSIT_CENTS - rec.settled, { rec, vaultBefore, vaultNow });

  // 6. Reserve check fails closed against a mint that reports outstanding above the vault.
  log("6. reserve check fails closed");
  const proxy = new Hono();
  proxy.get("/v1/blindfold/reserves", (c) => c.json({ issued: 10_000_000, settled: 0, outstanding: 10_000_000, keyset_id: "stub", updated_at: 0 }));
  proxy.all("*", (c) => fetch(mintUrl + new URL(c.req.url).pathname, { method: c.req.method, headers: c.req.raw.headers, body: c.req.method === "GET" ? undefined : c.req.raw.body, duplex: "half" } as RequestInit));
  const proxyPort = await freePort();
  const proxyServer = serve({ fetch: proxy.fetch, port: proxyPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(proxyServer));
  const before = walletCents();
  const r2 = await agent(["--topic", "sol"], `http://127.0.0.1:${proxyPort}`);
  check("agent exits 7 (reserves_failed)", r2.code === 7 && r2.out.error?.kind === "reserves_failed", r2);
  check("no proof left the wallet", walletCents() === before);

  log("\nE2E PASSED");
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error(e instanceof Error ? e.message : e);
}
for (const c of cleanups.reverse()) await Promise.resolve(c()).catch((e) => console.error("cleanup:", e?.message ?? e));
process.exit(failed ? 1 : 0);
