// Narrated demo, "Copycat vs. your trading agent", on a real Solana vault. Starts the mint, a token data feed and
// a live dashboard in this process, then: the agent researches SOL with standard x402 `exact` and Copycat (a bot
// reading public Solana data) spots it -> the owner funds Blindfold tokens -> the same research with Blindfold ->
// settlement -> Copycat's report -> a replayed payment is refused -> the agent refuses a dishonest mint.
//
//   pnpm demo                  devnet, the vault and keys in .keys/ (see docs/DEMO.md)
//   pnpm demo --localnet       rehearsal on a throwaway local validator with fresh keys (no devnet funds)
//   pnpm demo --no-pause       run straight through (default pauses between acts when interactive)
//   pnpm demo --calls 3        paid calls per payment method (1-10, default 3)
//   pnpm demo --no-dashboard   skip the live dashboard (default http://localhost:5173)
//
// Optional env: SOLANA_RPC_URL (a private devnet RPC avoids rate limits), DATABASE_URL (default: starts the
// repository's dev PostgreSQL), KEYS_DIR (default .keys).
import "./lib/quiet.js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import {
  createMint, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import {
  DEFAULT_VAULT_PROGRAM_ID, MAX_DEPOSIT_CENTS, SOLANA_COMMITMENT, USDC_DEVNET_MINT, buildInitializeIx, buildRegisterProviderIx,
  centsToBaseUnits, configPda, decodeConfig, decodeProviderRecord, providerPda, vaultAta,
} from "@blindfold/protocol";
import { AgentWallet, SolanaDepositor, ownerFund } from "@blindfold/wallet";
import { getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { createApp } from "../apps/mock-api/src/app.js";
import { exactFacilitator } from "../apps/mock-api/src/x402/exactBaseline.js";
import { HttpRedeemClient } from "../apps/mock-api/src/x402/redeemClient.js";
import { SolanaSettleSender } from "../services/mint/src/chain/settleSender.js";
import { SolanaVaultReader } from "../services/mint/src/chain/vaultReader.js";
import type { AppConfig } from "../services/mint/src/config.js";
import { createPool } from "../services/mint/src/db.js";
import { createMint as createMintServer } from "../services/mint/src/mint.js";
import { runMain } from "../agents/simple/src/main.js";
import type { Observation } from "./lib/bot.js";
import { ChainWatcher, describe as describeTx, infer } from "./lib/copycat.js";
import { startDashboard, type Dashboard, type DashboardEvent } from "./lib/dashboard.js";
import { exactPayFetch, paymentResponse } from "./lib/exactClient.js";
import { explorerAddress, explorerTx } from "./lib/explorer.js";
import { act, blank, bold, dim, green, kv, link, magenta, ok, pause, red, say, short, step, usd, warn, yellow } from "./lib/narrate.js";

// ---------------------------------------------------------------------------------------------------- options

const argv = process.argv.slice(2);
const localnet = argv.includes("--localnet");
const pausing = !argv.includes("--no-pause");
const withDashboard = !argv.includes("--no-dashboard");
const callsArg = argv.indexOf("--calls");
const CALLS = callsArg >= 0 ? Number(argv[callsArg + 1]) : 3;
if (!Number.isInteger(CALLS) || CALLS < 1 || CALLS > 10) throw new Error("--calls must be an integer from 1 to 10");
const PRICE = 5;
const DEPTH_PRICE = 10;
const FEED = "TokenFeed";
const DEPOSIT_CENTS = 100;
const TOPIC = "sol";
const ADMIN_TOKEN = randomBytes(16).toString("hex");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEYS = process.env.KEYS_DIR ?? join(ROOT, ".keys");
const solanaBin = `${homedir()}/.local/share/solana/install/active_release/bin`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cleanups: (() => Promise<void> | void)[] = [];
const explorerLinks: [string, string][] = [];
let dashboard = null as Dashboard | null; // set in main(); read after it returns

function fail(message: string): never {
  throw Object.assign(new Error(message), { demo: true });
}
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
function keyFile(name: string, create = false): Keypair {
  const p = join(KEYS, `${name}.json`);
  if (existsSync(p)) return loadKeypair(p);
  if (!create) fail(`missing ${p}. Restore .keys/ from your backup (see docs/DEMO.md).`);
  const k = Keypair.generate();
  writeFileSync(p, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  warn(`created ${p}; add it to your key backup`);
  return k;
}
async function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer().once("error", () => res(false)).listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}
async function pickPort(preferred?: number): Promise<number> {
  if (preferred && (await portFree(preferred))) return preferred;
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

// ---------------------------------------------------------------------------------------------------- chain setup

interface Cast {
  rpc: string;
  connection: Connection;
  programId: PublicKey;
  usdcMint: PublicKey;
  admin: Keypair;
  owner: Keypair;
  authority: Keypair;
  providerId: number;
  providerSecret: string;
  payoutOwner: PublicKey;
  payoutAta: PublicKey;
  exactAgent: Keypair;
  facilitator: Keypair;
}

const tokenBalance = async (c: Connection, ata: PublicKey) =>
  BigInt((await c.getTokenAccountBalance(ata, SOLANA_COMMITMENT).catch(() => ({ value: { amount: "0" } }))).value.amount);
const send = (c: Connection, ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(c, new Transaction().add(...ixs), signers, { commitment: SOLANA_COMMITMENT });

async function startValidator(rpc: string, programId: PublicKey) {
  const so = join(ROOT, "target/deploy/vault.so");
  if (!existsSync(so)) fail(`${so} missing: run \`anchor build\` first`);
  const c = new Connection(rpc, SOLANA_COMMITMENT);
  if (await c.getVersion().then(() => true, () => false)) fail("a validator is already running on 127.0.0.1:8899; stop it for a fresh --localnet rehearsal");
  const ledger = mkdtempSync(join(tmpdir(), "bf-demo-ledger-"));
  const v: ChildProcess = spawn(`${solanaBin}/solana-test-validator`, ["--bpf-program", programId.toBase58(), so, "--ledger", ledger, "--reset", "--quiet"], {
    stdio: "ignore", env: { ...process.env, PATH: `${solanaBin}:${process.env.PATH}` },
  });
  cleanups.push(() => { v.kill("SIGTERM"); });
  for (let i = 0; i < 90; i++) {
    if (await c.getVersion().then(() => true, () => false)) return;
    await sleep(1000);
  }
  fail("solana-test-validator did not start within 90 seconds");
}

async function airdrop(c: Connection, to: PublicKey, sol: number) {
  const sig = await c.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await c.confirmTransaction({ signature: sig, ...(await c.getLatestBlockhash()) }, SOLANA_COMMITMENT);
}

/** Localnet: everything fresh, provider 0 registered with a random key. */
async function localCast(): Promise<Cast> {
  const rpc = "http://127.0.0.1:8899";
  const programId = new PublicKey(DEFAULT_VAULT_PROGRAM_ID);
  step("starting a local Solana validator with the vault program");
  await startValidator(rpc, programId);
  const connection = new Connection(rpc, SOLANA_COMMITMENT);
  const [admin, owner, authority, payout, exactAgent, facilitator] = Array.from({ length: 6 }, () => Keypair.generate());
  for (const k of [admin, owner, authority, facilitator]) await airdrop(connection, k.publicKey, 5);
  const usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  for (const [k, amount] of [[owner, 20_000_000n], [exactAgent, 2_000_000n]] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, k.publicKey);
    await mintTo(connection, admin, usdcMint, ata.address, admin, amount);
  }
  await send(connection, [buildInitializeIx({ programId, admin: admin.publicKey, usdcMint, mintAuthority: authority.publicKey, maxDeposit: centsToBaseUnits(MAX_DEPOSIT_CENTS) })], [admin]);
  const providerSecret = hex(randomBytes(32));
  const payoutAta = (await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, payout.publicKey)).address;
  await send(connection, [buildRegisterProviderIx({
    programId, admin: admin.publicKey, providerId: 0, cashuPubkey: hex(getPubKeyFromPrivKey(Buffer.from(providerSecret, "hex"))), payoutToken: payoutAta,
  })], [admin]);
  return { rpc, connection, programId, usdcMint, admin, owner, authority, providerId: 0, providerSecret, payoutOwner: payout.publicKey, payoutAta, exactAgent, facilitator };
}

/** Devnet: the deployed vault, provider 0 and the keys in .keys/; tops up the baseline wallets if needed. */
async function devnetCast(): Promise<Cast> {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  if (/mainnet/i.test(rpc)) fail("refusing to run against mainnet");
  const connection = new Connection(rpc, SOLANA_COMMITMENT);
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
  const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
  if (!existsSync(KEYS)) fail(`${KEYS} not found. Restore your key backup into it (see docs/DEMO.md).`);
  const admin = keyFile("deployer");
  const owner = keyFile("owner");
  const authority = keyFile("mint-authority");
  const payout = keyFile("provider-payout");
  const exactAgent = keyFile("exact-agent", true);
  const facilitator = keyFile("facilitator", true);
  const secretPath = join(KEYS, "provider-secret.hex");
  if (!existsSync(secretPath)) fail(`missing ${secretPath}`);
  const providerSecret = readFileSync(secretPath, "utf8").trim();

  step(`checking the vault at ${programId.toBase58()}`);
  const cfgInfo = await connection.getAccountInfo(configPda(programId));
  if (!cfgInfo) fail(`vault Config not found for ${programId.toBase58()} on ${rpc}`);
  const config = decodeConfig(cfgInfo.data);
  if (!config.mintAuthority.equals(authority.publicKey)) fail("mint-authority.json does not match the vault's mint authority");
  if (!config.usdcMint.equals(usdcMint)) fail("USDC mint does not match the vault");

  // Provider 0 must be the active record for our provider key.
  const providerPubkey = hex(getPubKeyFromPrivKey(Buffer.from(providerSecret, "hex")));
  let providerId = -1;
  let payoutAta = PublicKey.default;
  for (let id = 0; id < config.providerCount; id++) {
    const info = await connection.getAccountInfo(providerPda(id, programId));
    if (!info) continue;
    const rec = decodeProviderRecord(info.data);
    if (rec.active && hex(rec.cashuPubkey) === providerPubkey) {
      providerId = id;
      payoutAta = rec.payoutToken;
      break;
    }
  }
  if (providerId < 0) fail("no active vault provider uses .keys/provider-secret.hex");
  if (!payoutAta.equals(getAssociatedTokenAddressSync(usdcMint, payout.publicKey))) fail("provider payout account is not provider-payout.json's USDC account");

  // Balances, with automatic top-ups for the operating wallets.
  const sol = async (k: PublicKey) => (await connection.getBalance(k, SOLANA_COMMITMENT)) / LAMPORTS_PER_SOL;
  const adminSol = await sol(admin.publicKey);
  for (const [name, k, min, give] of [["mint authority", authority, 0.02, 0.1], ["owner", owner, 0.02, 0.1], ["x402 facilitator", facilitator, 0.02, 0.1]] as const) {
    if ((await sol(k.publicKey)) >= min) continue;
    if (adminSol < give + 0.05) fail(`${name} ${k.publicKey.toBase58()} needs devnet SOL and the deployer cannot cover it; use faucet.solana.com`);
    step(`sending ${give} SOL from the deployer to the ${name}`);
    await send(connection, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: k.publicKey, lamports: give * LAMPORTS_PER_SOL })], [admin]);
  }
  const ownerAta = getAssociatedTokenAddressSync(usdcMint, owner.publicKey);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, exactAgent.publicKey);
  const exactNeed = centsToBaseUnits(PRICE * CALLS);
  if ((await tokenBalance(connection, agentAta)) < exactNeed) {
    const topUp = centsToBaseUnits(100);
    if ((await tokenBalance(connection, ownerAta)) < topUp + centsToBaseUnits(DEPOSIT_CENTS)) fail(`owner ${owner.publicKey.toBase58()} needs at least 2 devnet USDC (faucet.circle.com)`);
    step("sending 1 USDC from the owner to the baseline agent wallet");
    await getOrCreateAssociatedTokenAccount(connection, owner, usdcMint, exactAgent.publicKey);
    await send(connection, [createTransferCheckedInstruction(ownerAta, usdcMint, agentAta, owner.publicKey, topUp, 6)], [owner]);
  }
  if ((await tokenBalance(connection, ownerAta)) < centsToBaseUnits(DEPOSIT_CENTS)) fail(`owner ${owner.publicKey.toBase58()} needs at least 1 devnet USDC (faucet.circle.com)`);
  return { rpc, connection, programId, usdcMint, admin, owner, authority, providerId, providerSecret, payoutOwner: payout.publicKey, payoutAta, exactAgent, facilitator };
}

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  step("starting the repository's local PostgreSQL (services/mint/scripts/dev-pg.sh)");
  return execFileSync(join(ROOT, "services/mint/scripts/dev-pg.sh"), { encoding: "utf8" }).trim().split("\n").pop()!;
}

// ---------------------------------------------------------------------------------------------------- demo

async function main() {
  act("Copycat vs. your trading agent", "Every time your agent pays for data with standard x402, it publishes what it's researching onchain. Blindfold lets it pay without telling the world.");
  say(dim(localnet ? "Mode: local rehearsal (throwaway validator, fresh keys)." : "Mode: Solana devnet, real vault program and USDC."));
  if (!localnet && !process.env.SOLANA_RPC_URL) say(yellow("Using the public devnet RPC, which rate-limits heavily. For a smooth recording set SOLANA_RPC_URL to a free Helius or QuickNode devnet URL (docs/DEMO.md)."));
  blank();
  step("setting up");
  const cast = localnet ? await localCast() : await devnetCast();
  const { rpc, connection, programId, usdcMint } = cast;
  const vaultToken = vaultAta(usdcMint, programId);

  // Mint and mock API in this process, on the standard local ports when they are free.
  const dbUrl = databaseUrl();
  const schema = `demo_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  await adminPool.query(`create schema ${schema}`);
  const db = createPool(dbUrl, schema);
  cleanups.push(async () => { await db.end(); await adminPool.query(`drop schema ${schema} cascade`); await adminPool.end(); });
  const [mintPort, apiPort] = [await pickPort(3338), await pickPort(4000)];
  const mintUrl = `http://localhost:${mintPort}`;
  const apiUrl = `http://localhost:${apiPort}`;
  const cfg: AppConfig = {
    SOLANA_RPC_URL: rpc, VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: usdcMint.toBase58(), MINT_URL: mintUrl,
    DATABASE_URL: dbUrl, MINT_SEED: randomBytes(32).toString("hex"), MINT_AUTHORITY_KEYPAIR: "", MINT_ADMIN_TOKEN: ADMIN_TOKEN, PORT: mintPort,
    providers: [{ provider_id: cast.providerId, name: "token-feed", url: apiUrl, price_cents: PRICE, topics: ["sol", "btc", "eth"] }],
    depositPollMs: localnet ? 1000 : 2000, settleIntervalS: 86_400, devFakeChain: false,
  };
  step("starting the mint");
  const { app: mintApp, start } = await createMintServer({
    db, cfg, vault: new SolanaVaultReader(connection, programId, usdcMint),
    sender: new SolanaSettleSender(connection, programId, usdcMint, cast.authority), confirmTimeoutMs: 90_000,
  });
  const stopJobs = start();
  cleanups.push(stopJobs);
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

  step(`starting the provider (${FEED}, a mock token data feed)`);
  const apiLogs: Record<string, unknown>[] = [];
  const facilitator = await exactFacilitator({ keypair: cast.facilitator.secretKey, rpcUrl: rpc });
  const api = createApp({
    mintUrl, providerSecretKey: cast.providerSecret, priceCents: PRICE, depthPriceCents: DEPTH_PRICE, usdcMint: usdcMint.toBase58(), providerId: cast.providerId,
    redeem: new HttpRedeemClient(mintUrl), log: (e) => apiLogs.push(e),
    // The feed tags its exact payments with the feed and token (x402 `extra.memo`), as sellers do to reconcile payments.
    exact: { payTo: cast.payoutOwner.toBase58(), facilitator, memoTopics: ["sol", "btc", "eth"] },
  });
  const apiServer = serve({ fetch: api.fetch, port: apiPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(apiServer));

  const dir = mkdtempSync(join(tmpdir(), "bf-demo-"));
  const tokenFile = join(dir, "agent-tokens.json");
  const walletCents = () => existsSync(tokenFile) ? (JSON.parse(readFileSync(tokenFile, "utf8")).proofs as { amount: number }[]).reduce((s, p) => s + p.amount, 0) : 0;
  const agentEnv = (url = mintUrl) => ({ TOKEN_FILE: tokenFile, MINT_URL: url, SOLANA_RPC_URL: rpc, VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: usdcMint.toBase58() });
  const agent = async (args: string[], url?: string) => {
    let stdout = "";
    const code = await runMain(["--json", ...args], agentEnv(url), { stdout: (s) => (stdout += s), stderr: () => undefined });
    return { code, out: JSON.parse(stdout) as any };
  };
  const startSlot = await connection.getSlot(SOLANA_COMMITMENT);
  const vaultStart = await tokenBalance(connection, vaultToken);
  const exactAta = getAssociatedTokenAddressSync(usdcMint, cast.exactAgent.publicKey);
  const exactAddress = cast.exactAgent.publicKey.toBase58();

  // The dashboard and Copycat. Copycat polls the feed's USDC account and the vault from this slot on, like any
  // outside observer; the dashboard shows each transaction as Copycat finds it.
  let dash: Dashboard | null = null;
  if (withDashboard) {
    dash = dashboard = await startDashboard({ port: await pickPort(5173) });
    cleanups.push(() => dash!.close());
  }
  const emit = (e: DashboardEvent) => dash?.emit(e);
  const tagged = (o: Observation) => o.kind === "direct_payment" ? "exact" : "blindfold";
  let balancing: Promise<void> | null = null;
  const refreshBalances = () => {
    if (!dash) return Promise.resolve();
    balancing ??= (async () => {
      const obs = watcher.observations;
      const sum = (k: string) => obs.filter((o) => o.kind === k).reduce((t, o) => t + o.amountBase, 0n);
      const owed = ((await mintReq("/v1/blindfold/admin/balances", { auth: true })).json as any[]).find((b) => b.provider_id === cast.providerId)?.balance ?? 0;
      emit({
        type: "balances", agentTokensCents: walletCents(), exactWalletBase: String(await tokenBalance(connection, exactAta)),
        providerDirectBase: String(sum("direct_payment")), providerSettledBase: String(sum("vault_payout")), providerOwedCents: owed,
        vaultBase: String(await tokenBalance(connection, vaultToken)),
      });
    })().catch(() => undefined).finally(() => { balancing = null; });
    return balancing;
  };
  const watcher = new ChainWatcher({
    connection, accounts: [cast.payoutAta, vaultToken], usdcMint, vaultToken, sinceSlot: startSlot, intervalMs: localnet ? 2000 : 5000,
    onObservation: (o) => {
      emit({
        type: "chain", side: tagged(o), kind: o.kind, text: describeTx(o), amountBase: String(o.amountBase), from: o.from, memo: o.memo,
        time: o.time?.toISOString() ?? null, url: explorerTx(o.signature, rpc), signature: o.signature,
      });
      const signal = infer(watcher.observations).find((x) => x.payer === exactAddress);
      if (o.kind === "direct_payment" && signal) emit({ type: "copycat", side: "exact", action: signal.action, reason: signal.reason, tone: "alarm" });
      void refreshBalances();
    },
  });
  if (dash) watcher.start();
  cleanups.push(() => watcher.stop());
  const copycat = (text: string) => console.log(`  ${bold(magenta("Copycat"))}  ${text}`);
  // The dashboard gets a short caption per act; the terminal keeps the full title.
  const captions = ["Ready", "Paying with standard x402", "Funding Blindfold tokens", "Paying with Blindfold", "Provider paid in one batch",
    "What the watcher learned", "Replayed payment refused", "Dishonest mint refused", "Summary"];
  const scene = (n: number, title: string, subtitle: string) => {
    act(`${n}. ${title}`, subtitle);
    emit({ type: "act", n, title: captions[n] });
  };
  const flow = (d: any) => d ? `whale netflow ${d.whale_netflow >= 0 ? "+" : "-"}$${Math.abs(d.whale_netflow).toLocaleString("en-US")} in 1h (${d.whale_buys} buys, ${d.whale_sells} sells)` : "";

  // Cast of characters.
  blank();
  say(bold("Who is involved"));
  kv("Your agent", `a trading agent researching ${TOPIC.toUpperCase()} before it trades`);
  kv(FEED, `a token data feed at ${apiUrl}: whale flow ${PRICE} cents, order-book depth ${DEPTH_PRICE} cents a call, paid over x402`);
  kv("Copycat", "a bot reading only public Solana data, looking for agents to front-run");
  kv("Owner", `${short(cast.owner.publicKey.toBase58())}  funds the agent`);
  kv("Blindfold", `a mint at ${mintUrl} and a vault program ${short(programId.toBase58())} holding the USDC`);
  link("vault", explorerAddress(programId.toBase58(), rpc));
  if (dash) {
    blank();
    say(`${bold("Live dashboard:")} ${dash.url}  ${dim("(open it next to this terminal)")}`);
  }
  emit({
    type: "setup", mode: localnet ? "localnet" : "devnet", topic: TOPIC, prices: { whaleFlow: PRICE, depth: DEPTH_PRICE }, exactWallet: exactAddress,
    vault: vaultToken.toBase58(), provider: cast.payoutAta.toBase58(), links: { vault: explorerAddress(programId.toBase58(), rpc) },
  });
  emit({ type: "act", n: 0, title: captions[0] });
  void refreshBalances();
  await pause(pausing);

  // Act 1: standard x402.
  scene(1, `Your agent researches ${TOPIC.toUpperCase()} with standard x402`, `The agent pays ${FEED} with x402's standard \`exact\` scheme: it holds a Solana wallet with USDC and signs a transfer for every call.`);
  const payer = await exactPayFetch({ keypair: cast.exactAgent.secretKey, rpcUrl: rpc, usdcMint: usdcMint.toBase58() });
  kv("Agent wallet", `${payer.address}  ${yellow("(a key the agent must hold)")}`);
  // Building the payment reads the chain; on a rate-limited RPC that can fail before anything is sent, which is
  // safe to retry. A failure after the transfer was submitted is not retried.
  const payExact = async (url: string): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await payer.fetch(url);
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt >= 6 || !/Failed to create payment payload/.test(msg)) throw e;
        step(`RPC busy (${msg.includes("429") ? "rate limited" : "error"}); retrying the payment, nothing was sent`);
        await sleep(2000 * attempt);
      }
    }
  };
  const exactSigs: string[] = [];
  for (let i = 0; i < CALLS; i++) {
    // Spaced so each payment gets a fresh blockhash (the memo is the same every call, so the bytes would match).
    if (i > 0) await sleep(localnet ? 1200 : 1500);
    const res = await payExact(`${apiUrl}/v1/data/${TOPIC}`);
    const pr = paymentResponse(res);
    if (res.status !== 200 || !pr?.transaction) fail(`exact call ${i + 1} failed: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    exactSigs.push(pr.transaction);
    ok(`call ${i + 1}: paid ${PRICE} cents, ${TOPIC.toUpperCase()} ${flow(body)}`);
    link(`tx ${i + 1}`, explorerTx(pr.transaction, rpc));
    explorerLinks.push([`Standard x402 payment ${i + 1}`, explorerTx(pr.transaction, rpc)]);
    emit({ type: "call", side: "exact", n: i + 1, cents: PRICE, label: `whale flow ${TOPIC.toUpperCase()}`, ok: true, tx: pr.transaction, url: explorerTx(pr.transaction, rpc) });
    void refreshBalances();
  }
  say("Each call is its own public Solana transfer from the agent's wallet to the feed. Now Copycat reads the chain.");
  step("Copycat is scanning the feed's USDC account");
  await watcher.waitFor((o) => exactSigs.every((x) => o.some((y) => y.signature === x)), 90_000);
  const signal = infer(watcher.observations).find((x) => x.payer === exactAddress);
  if (!signal) fail("Copycat did not find the exact payments onchain");
  blank();
  copycat(`${bold(red(signal.action))}`);
  copycat(signal.reason);
  emit({ type: "copycat", side: "exact", action: signal.action, reason: signal.reason, tone: "alarm" });
  say(dim(`Copycat saw the wallet, the feed, the amounts, the timing and the memo ${FEED} attached to each payment for its own bookkeeping. Without the memo it still sees the wallet, the feed and the burst.`));
  await pause(pausing);

  // Act 2: fund.
  scene(2, "Switch to Blindfold: the owner funds the agent", "USDC goes into the vault; the agent receives blind-signed tokens that only registered providers can redeem.");
  const depositor = new SolanaDepositor({ rpcUrl: rpc, owner: cast.owner, programId, usdcMint });
  const labels: Record<string, string> = {
    quote: "requesting a mint quote", deposit: "depositing $1.00 of USDC into the vault (Solana transaction)", wait_paid: "waiting for the mint to see the deposit onchain",
    mint: "blinding tokens and getting them signed", write: "verifying signatures and writing the agent's token file",
  };
  const funded = await ownerFund({
    mintUrl, cents: DEPOSIT_CENTS, tokenFile, depositor, stateDir: join(dir, "owner"), pollMs: 1000, timeoutMs: 180_000,
    onProgress: (st) => step(labels[st] ?? st),
  });
  // Background deposit polling and provider sync are no longer needed (settlement syncs itself); stopping them
  // spares a rate-limited public RPC for the rest of the demo.
  stopJobs();
  ok(`agent holds ${walletCents()} cents in ${funded.proofs} tokens, and no Solana key`);
  link("deposit", explorerTx(funded.depositTx, rpc));
  explorerLinks.push(["Owner deposit into the vault", explorerTx(funded.depositTx, rpc)]);
  void refreshBalances();
  say("The mint signed the tokens blind: it cannot link these tokens to the purchases they will make.");
  await watcher.waitFor((o) => o.some((y) => y.signature === funded.depositTx), 60_000);
  const dep = watcher.observations.find((y) => y.signature === funded.depositTx);
  blank();
  copycat(dep ? describeTx(dep) : "no deposit seen yet");
  emit({ type: "copycat", side: "blindfold", action: "NO SIGNAL", reason: "A deposit into a shared vault. Who it pays, for what, and when: unknown.", tone: "calm" });
  await pause(pausing);

  // Act 3: buy with Blindfold.
  scene(3, `The same research, paid with Blindfold`, `Same agent, same feed, same ${CALLS} whale-flow reads on ${TOPIC.toUpperCase()}. Before paying, the agent checks the vault's USDC on Solana against the mint's liabilities.`);
  const before = walletCents();
  const knownBefore = watcher.observations.length;
  const r1 = await agent(["--topic", TOPIC, "--calls", String(CALLS)]);
  if (r1.code !== 0) fail(`agent failed: ${JSON.stringify(r1.out)}`);
  ok(`reserve check: vault holds ${usd(centsToBaseUnits(r1.out.reserves.vaultCents))}, mint owes ${usd(centsToBaseUnits(r1.out.reserves.outstandingCents))}`);
  for (const [i, c] of (r1.out.calls as any[]).entries()) {
    ok(`call ${i + 1}: paid ${c.paidCents} cents, ${TOPIC.toUpperCase()} ${flow(c.data)}  ${dim(`(redemption ${String(c.redemptionId).slice(0, 8)})`)}`);
    emit({ type: "call", side: "blindfold", n: i + 1, cents: c.paidCents, label: `whale flow ${TOPIC.toUpperCase()}`, ok: c.status === 200 });
  }
  ok(`tokens ${before} -> ${walletCents()} cents`);
  void refreshBalances();
  say("Each payment was an ecash token in an HTTP header. No Solana transaction happened.");
  step("Copycat is scanning the feed's USDC account and the vault");
  await sleep(localnet ? 2000 : 4000);
  await watcher.scan().catch(() => undefined);
  const fresh = watcher.observations.slice(knownBefore).filter((o) => o.kind === "direct_payment");
  if (fresh.length) fail(`Copycat saw ${fresh.length} direct payments during the Blindfold calls`);
  blank();
  copycat(`${bold(green("NO SIGNAL"))}`);
  copycat(`Nothing new onchain. ${CALLS} purchases, 0 transactions.`);
  emit({ type: "copycat", side: "blindfold", action: "NO SIGNAL", reason: `${CALLS} purchases, 0 transactions. Nothing onchain names your agent, the feed or ${TOPIC.toUpperCase()}.`, tone: "calm" });
  await pause(pausing);

  // Act 4: settle.
  scene(4, `${FEED} gets paid in USDC`, "The mint batches what each provider is owed into one vault transaction.");
  const owed = ((await mintReq("/v1/blindfold/admin/balances", { auth: true })).json as any[]).find((b) => b.provider_id === cast.providerId)?.balance ?? 0;
  const payoutBefore = await tokenBalance(connection, cast.payoutAta);
  const settled = await mintReq("/v1/blindfold/admin/settle", { body: {}, auth: true });
  if (settled.status !== 200) fail(`settlement failed: ${JSON.stringify(settled.json)}`);
  const paid = (await tokenBalance(connection, cast.payoutAta)) - payoutBefore;
  ok(`owed ${owed} cents; the feed's USDC account received ${usd(paid)} in one transaction`);
  link("settle", explorerTx(settled.json.tx, rpc));
  explorerLinks.push(["Vault settlement batch to the feed", explorerTx(settled.json.tx, rpc)]);
  // This run's books: the vault moved by exactly this deposit minus this payout. (The vault's total also backs
  // tokens from earlier sessions, which this fresh mint database does not track.)
  const vaultNow = await tokenBalance(connection, vaultToken);
  const delta = vaultNow - vaultStart;
  const expected = centsToBaseUnits(DEPOSIT_CENTS) - paid;
  if (delta !== expected) fail(`vault moved ${usd(delta)}, expected ${usd(expected)}`);
  const rec = (await mintReq("/v1/blindfold/admin/reconcile", { auth: true })).json;
  if (centsToBaseUnits(rec.settled) !== paid || rec.issued !== DEPOSIT_CENTS) fail(`mint records disagree: ${JSON.stringify(rec)}`);
  ok(`books: vault +${usd(centsToBaseUnits(DEPOSIT_CENTS))} deposit - ${usd(paid)} payout = +${usd(delta)} this session, matching the mint's records`);
  void refreshBalances();
  await watcher.waitFor((o) => o.some((y) => y.signature === settled.json.tx), 60_000);
  const payout = watcher.observations.find((y) => y.signature === settled.json.tx);
  blank();
  copycat(payout ? describeTx(payout) : "no payout seen yet");
  emit({ type: "copycat", side: "blindfold", action: "NO SIGNAL", reason: "One deposit in, one batch payout out. The payout covers many calls and names no agent.", tone: "calm" });
  say("One payout covers many calls. The chain shows the vault paying the feed, not which agent bought what.");
  await pause(pausing);

  // Act 5: Copycat's report.
  scene(5, "Copycat's report", "Everything Copycat learned from public Solana data during this run.");
  const fmt = (d: Date | null) => (d ? d.toISOString().slice(11, 19) : "?");
  blank();
  say(bold(red("Standard x402 (exact)")));
  kv("Agent wallet", signal.payer);
  kv("Purchases", `${signal.calls} calls to ${FEED}, ${usd(signal.totalBase)} total`);
  kv("About", `${Object.entries(signal.feeds).map(([f, n]) => `${n} ${f}`).join(", ")}${signal.token ? ` on ${signal.token}` : ""}`);
  kv("Times (UTC)", watcher.observations.filter((o) => o.kind === "direct_payment" && o.from === signal.payer).map((o) => fmt(o.time)).join(", "));
  kv("Signal", bold(red(signal.action)));
  blank();
  say(bold(green("Blindfold (cashu)")));
  for (const d of watcher.observations.filter((x) => x.kind === "vault_deposit")) kv("Deposit", `${short(d.from)} put ${usd(d.amountBase)} into the vault at ${fmt(d.time)}`);
  for (const p of watcher.observations.filter((x) => x.kind === "vault_payout")) kv("Payout", `vault paid ${FEED} ${usd(p.amountBase)} in one batch at ${fmt(p.time)}`);
  kv("Agent wallet", "none: the agent has no onchain identity");
  kv("Per-call data", `none: ${CALLS} purchases, 0 transactions`);
  kv("Signal", bold(green("NO SIGNAL")));
  blank();
  say(dim("Honest limit: with very few users, or distinctive amounts and timing, deposits and payouts can still be correlated. Privacy grows with the number of people using the mint."));
  await pause(pausing);

  // Act 6: replay.
  scene(6, "Safety: a copied payment buys nothing", "Privacy without giving up safety. Someone intercepts a paid request and sends it again.");
  let header = "";
  const spy: typeof fetch = async (i, init) => {
    const h = new Request(i as Request, init).headers.get("payment-signature");
    if (h) header = h;
    return fetch(i, init);
  };
  const wallet = await AgentWallet.open({ tokenFile, maxPerCallCents: 10, usdcMint: usdcMint.toBase58(), fetch: spy });
  try {
    const res = await wallet.payFetch(`${apiUrl}/v1/data/${TOPIC}`);
    ok(`agent's call: HTTP ${res.status}`);
    emit({ type: "call", side: "blindfold", n: CALLS + 1, cents: PRICE, label: `whale flow ${TOPIC.toUpperCase()}`, ok: res.status === 200 });
  } finally {
    wallet.close();
  }
  const replay = await fetch(`${apiUrl}/v1/data/${TOPIC}`, { headers: { "PAYMENT-SIGNATURE": header } });
  const reason = apiLogs.map((l) => String(l.outcome ?? "")).reverse().find((o) => o.startsWith("rejected:")) ?? "";
  if (replay.status !== 402) fail(`replay was not refused (HTTP ${replay.status})`);
  ok(`replayed call: HTTP ${replay.status}, refused (${reason.replace("rejected:", "")}: token already spent)`);
  emit({ type: "note", side: "blindfold", tone: "ok", text: "Replayed payment refused" });
  void refreshBalances();
  say("The mint marks every token spent the moment a provider redeems it, so a copied payment buys nothing.");
  await pause(pausing);

  // Act 7: reserve gate.
  scene(7, "Safety: the agent refuses a dishonest mint", "Suppose the mint claims more outstanding tokens than the vault holds.");
  const proxy = new Hono();
  proxy.get("/v1/blindfold/reserves", (c) => c.json({ issued: 10_000_000, settled: 0, outstanding: 10_000_000, keyset_id: "lying-mint", updated_at: 0 }));
  proxy.all("*", (c) => fetch(mintUrl + new URL(c.req.url).pathname, { method: c.req.method, headers: c.req.raw.headers, body: c.req.method === "GET" ? undefined : c.req.raw.body, duplex: "half" } as RequestInit));
  const proxyPort = await pickPort();
  const proxyServer = serve({ fetch: proxy.fetch, port: proxyPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(proxyServer));
  const kept = walletCents();
  const r2 = await agent(["--topic", TOPIC], `http://127.0.0.1:${proxyPort}`);
  if (r2.code !== 7) fail(`agent did not refuse: ${JSON.stringify(r2.out)}`);
  ok(`agent stopped before paying: ${r2.out.error.reason} (exit code 7)`);
  ok(`tokens untouched: still ${kept} cents`);
  emit({ type: "note", side: "blindfold", tone: "warn", text: "Overstated reserves refused, nothing paid" });
  say("The agent verifies the vault itself instead of trusting the mint's word. If the numbers don't add up, it pays nothing. And its tokens only pay registered providers, so a hijacked agent cannot pay an attacker.");
  await pause(pausing, "Press Enter for the summary");

  // Summary.
  act("Summary");
  emit({ type: "act", n: 8, title: captions[8] });
  say(`${red("Standard x402")}: the agent needed a funded wallet, every call became a public transfer, and Copycat turned them into "${signal.action}".`);
  say(`${green("Blindfold")}: the same research with no key and no transaction per call. Copycat saw a deposit and a batch payout: no signal. Replays were refused and the agent refused a mint that lied about reserves.`);
  blank();
  say(bold("Solana Explorer"));
  for (const [label, url] of explorerLinks) {
    say(label);
    say(dim(url));
  }
  await refreshBalances();
}

let failed = false;
const onSignal = () => { failed = true; void cleanup().then(() => process.exit(130)); };
process.once("SIGINT", onSignal);
async function cleanup() {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
  cleanups.length = 0;
}
try {
  await main();
  blank();
  console.log(green(bold("Demo complete.")));
  dashboard?.emit({ type: "done", ok: true });
  // Keep the final dashboard on screen for recording.
  if (dashboard) await pause(pausing, `Dashboard still live at ${dashboard.url}. Press Enter to exit`);
} catch (e) {
  failed = true;
  blank();
  console.error(red(`Demo stopped: ${(e as Error).message}`));
  if (!(e as { demo?: boolean }).demo) console.error(dim((e as Error).stack ?? ""));
  dashboard?.emit({ type: "done", ok: false });
}
await cleanup();
process.exit(failed ? 1 : 0);
