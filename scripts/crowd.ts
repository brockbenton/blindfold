// Crowd demo: privacy needs other people. Several agents, each with its own owner wallet, research different
// tokens with interleaved timing. With standard x402 `exact`, Copycat attributes every purchase to a wallet and a
// token. With Blindfold, each owner deposits the same amount, the agents pay with tokens, and one settlement batch
// pays the feed for all of it: Copycat sees N deposits and one payout and cannot attribute the purchases. A second
// round with one big deposit and small ones shows how odd amounts give a depositor away.
//
//   pnpm crowd                 local validator with fresh keys (needs `anchor build` and the Solana tools)
//   pnpm crowd --agents 3      agents in the crowd (2-5, default 3)
//   pnpm crowd --no-pause      run straight through
//   pnpm crowd --no-dashboard  skip the live crowd dashboard (default http://localhost:5173)
//   pnpm crowd --record FILE   also save the dashboard events and narration for the replay page (pnpm replay FILE)
//
// Localnet only: a devnet crowd needs owners funded independently of each other (see docs/DEMO.md).
// Optional env: DATABASE_URL (default: starts the repository's dev PostgreSQL).
import "./lib/quiet.js";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import pg from "pg";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import {
  DEFAULT_VAULT_PROGRAM_ID, MAX_DEPOSIT_CENTS, SOLANA_COMMITMENT, buildInitializeIx, buildRegisterProviderIx, centsToBaseUnits, vaultAta,
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
import { ChainWatcher, attributeVault, describe as describeTx, infer } from "./lib/copycat.js";
import { startDashboard, type Dashboard } from "./lib/dashboard.js";
import { exactPayFetch, paymentResponse } from "./lib/exactClient.js";
import { explorerTx } from "./lib/explorer.js";
import { startRecorder } from "./lib/recorder.js";
import { act, blank, bold, dim, green, kv, magenta, ok, pause, red, say, short, step, usd, yellow } from "./lib/narrate.js";

const argv = process.argv.slice(2);
const pausing = !argv.includes("--no-pause");
const recordArg = argv.indexOf("--record");
if (recordArg >= 0 && !/^[^-]/.test(argv[recordArg + 1] ?? "")) throw new Error("--record needs a file name");
const recorder = recordArg >= 0 ? startRecorder({ file: resolve(process.env.INIT_CWD ?? process.cwd(), argv[recordArg + 1]), demo: "crowd" }) : null;
const withDashboard = !argv.includes("--no-dashboard") || recorder !== null;
const agentsArg = argv.indexOf("--agents");
const N = agentsArg >= 0 ? Number(argv[agentsArg + 1]) : 3;
if (!Number.isInteger(N) || N < 2 || N > 5) throw new Error("--agents must be an integer from 2 to 5");
if (argv.some((a) => a === "--devnet" || a === "--crowd")) throw new Error("pnpm crowd runs on a local validator only; see docs/DEMO.md");
const PRICE = 5;
const DEPTH_PRICE = 10;
const FEED = "TokenFeed";
/** Every owner deposits the same amount, so amounts cannot tell them apart. */
const DEPOSIT_CENTS = 100;
const TOPICS = ["sol", "btc", "eth", "jup", "bonk"];
/** Each agent's research plan: whale flow (`w`) and order-book depth (`d`) reads on its own token. */
const PLANS = [["w", "w", "d"], ["d", "w"], ["w", "d", "w"], ["w", "w"], ["d", "d", "w"]];
/** The uneven round: Agent A's owner deposits an odd, large amount, the others a little each. */
const BIG_CENTS = 237;
const SMALL_CENTS = 10;
const BIG_PLAN = ["w", "w", "w", "d", "d"];
const ADMIN_TOKEN = randomBytes(16).toString("hex");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const solanaBin = `${homedir()}/.local/share/solana/install/active_release/bin`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cleanups: (() => Promise<void> | void)[] = [];
let dashboard = null as Dashboard<CrowdEvent> | null; // set in main(); read after it returns

/** What the crowd dashboard (scripts/dashboard/crowd.html) receives. */
export type CrowdEvent =
  | { type: "setup"; mode: "localnet"; prices: { whaleFlow: number; depth: number }; agents: { name: string; token: string; wallet: string; owner: string }[] }
  | { type: "act"; n: number; title: string }
  | { type: "call"; side: "exact" | "blindfold"; agent: number; label: string; cents: number; url?: string }
  | { type: "chain"; kind: string; from: string; amountBase: string; memo?: string; time: string | null; url: string; round: 1 | 2 }
  | { type: "exact"; signals: { payer: string; token: string | null; calls: number; totalBase: string; action: string }[]; final?: boolean }
  | { type: "vault"; round: 1 | 2; action: string; reason: string; forced: string[] }
  | { type: "tokens"; cents: number[] }
  | { type: "feed"; earnedBase: string; vaultBase: string }
  | { type: "done"; ok: boolean };

function fail(message: string): never {
  throw Object.assign(new Error(message), { demo: true });
}
async function pickPort(preferred?: number): Promise<number> {
  const free = (p: number) => new Promise<boolean>((res) => {
    const s = createServer().once("error", () => res(false)).listen(p, "127.0.0.1", () => s.close(() => res(true)));
  });
  if (preferred && (await free(preferred))) return preferred;
  return new Promise((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
const tokenBalance = async (c: Connection, ata: PublicKey) =>
  BigInt((await c.getTokenAccountBalance(ata, SOLANA_COMMITMENT).catch(() => ({ value: { amount: "0" } }))).value.amount);
const send = (c: Connection, ixs: TransactionInstruction[], signers: Keypair[]) =>
  sendAndConfirmTransaction(c, new Transaction().add(...ixs), signers, { commitment: SOLANA_COMMITMENT });
/** A fair shuffle, so the order of deposits and purchases says nothing about who is who. */
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Interleaves every agent's plan: each round, the agents with calls left go in a random order. */
function schedule(): { agent: number; path: string }[] {
  const out: { agent: number; path: string }[] = [];
  for (let round = 0; out.length < PLANS.slice(0, N).flat().length; round++) {
    for (const i of shuffle([...Array(N).keys()])) {
      const p = PLANS[i][round];
      if (p) out.push({ agent: i, path: `/v1/data/${TOPICS[i]}${p === "d" ? "/depth" : ""}` });
    }
  }
  return out;
}
const label = (path: string) => `${path.endsWith("/depth") ? "depth" : "whale flow"} ${path.split("/")[3].toUpperCase()}`;
const cents = (path: string) => (path.endsWith("/depth") ? DEPTH_PRICE : PRICE);

async function startValidator(rpc: string, programId: PublicKey) {
  const so = join(ROOT, "target/deploy/vault.so");
  if (!existsSync(so)) fail(`${so} missing: run \`anchor build\` first`);
  const c = new Connection(rpc, SOLANA_COMMITMENT);
  if (await c.getVersion().then(() => true, () => false)) fail("a validator is already running on 127.0.0.1:8899; stop it first");
  const ledger = mkdtempSync(join(tmpdir(), "bf-crowd-ledger-"));
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

async function main() {
  act("Privacy needs a crowd", `${N} trading agents, ${N} owners, one data feed. Copycat reads public Solana data and tries to work out who is researching what.`);
  say(dim("Mode: local rehearsal (throwaway validator, fresh keys)."));
  blank();

  // ---------------------------------------------------------------- chain: everything funded before Copycat looks
  const rpc = "http://127.0.0.1:8899";
  const programId = new PublicKey(DEFAULT_VAULT_PROGRAM_ID);
  step("starting a local Solana validator with the vault program");
  await startValidator(rpc, programId);
  const connection = new Connection(rpc, SOLANA_COMMITMENT);
  const [admin, authority, payout, facilitatorKey] = Array.from({ length: 4 }, () => Keypair.generate());
  const owners = Array.from({ length: N }, () => Keypair.generate());
  const exactAgents = Array.from({ length: N }, () => Keypair.generate());
  step(`funding ${N} owners and ${N} exact agents, each straight from the test USDC mint`);
  for (const k of [admin, authority, facilitatorKey, ...owners]) {
    const sig = await connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, SOLANA_COMMITMENT);
  }
  const usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
  // The local stand-in for each owner buying USDC on its own: no wallet-to-wallet transfer links the owners.
  for (const k of [...owners, ...exactAgents]) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, k.publicKey);
    await mintTo(connection, admin, usdcMint, ata.address, admin, 5_000_000n);
  }
  await send(connection, [buildInitializeIx({ programId, admin: admin.publicKey, usdcMint, mintAuthority: authority.publicKey, maxDeposit: centsToBaseUnits(MAX_DEPOSIT_CENTS) })], [admin]);
  const providerSecret = hex(randomBytes(32));
  const payoutAta = (await getOrCreateAssociatedTokenAccount(connection, admin, usdcMint, payout.publicKey)).address;
  await send(connection, [buildRegisterProviderIx({
    programId, admin: admin.publicKey, providerId: 0, cashuPubkey: hex(getPubKeyFromPrivKey(Buffer.from(providerSecret, "hex"))), payoutToken: payoutAta,
  })], [admin]);
  const vaultToken = vaultAta(usdcMint, programId);

  // ---------------------------------------------------------------- mint and feed in this process
  let dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    step("starting the repository's local PostgreSQL (services/mint/scripts/dev-pg.sh)");
    dbUrl = execFileSync(join(ROOT, "services/mint/scripts/dev-pg.sh"), { encoding: "utf8" }).trim().split("\n").pop()!;
  }
  const schema = `crowd_${randomBytes(6).toString("hex")}`;
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
    providers: [{ provider_id: 0, name: "token-feed", url: apiUrl, price_cents: PRICE, topics: TOPICS }],
    depositPollMs: 1000, settleIntervalS: 86_400, devFakeChain: false,
  };
  step("starting the mint and the feed");
  const { app: mintApp, start } = await createMintServer({
    db, cfg, vault: new SolanaVaultReader(connection, programId, usdcMint),
    sender: new SolanaSettleSender(connection, programId, usdcMint, authority), confirmTimeoutMs: 90_000,
  });
  // Deposits and provider sync only: this demo settles on demand (below), so the mint's clock-aligned settlement
  // timer stays off and cannot race those calls.
  const stopJobs = start(["deposits", "providers"]);
  cleanups.push(stopJobs);
  const stop = (s: ReturnType<typeof serve>) => new Promise<void>((r) => { (s as any).closeAllConnections?.(); s.close(() => r()); });
  const mintServer = serve({ fetch: mintApp.fetch, port: mintPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(mintServer));
  const admin_ = async (path: string, body?: unknown) => {
    const r = await fetch(mintUrl + path, {
      method: body !== undefined ? "POST" : "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  const facilitator = await exactFacilitator({ keypair: facilitatorKey.secretKey, rpcUrl: rpc });
  const api = createApp({
    mintUrl, providerSecretKey: providerSecret, priceCents: PRICE, depthPriceCents: DEPTH_PRICE, usdcMint: usdcMint.toBase58(), providerId: 0,
    redeem: new HttpRedeemClient(mintUrl), log: () => undefined,
    exact: { payTo: payout.publicKey.toBase58(), facilitator, memoTopics: TOPICS },
  });
  const apiServer = serve({ fetch: api.fetch, port: apiPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(apiServer));

  // Copycat watches from here on: the feed's USDC account and the vault. The dashboard shows what it finds.
  const startSlot = await connection.getSlot(SOLANA_COMMITMENT);
  const vaultStart = await tokenBalance(connection, vaultToken);
  let dash: Dashboard<CrowdEvent> | null = null;
  if (withDashboard) {
    dash = dashboard = await startDashboard<CrowdEvent>({ port: await pickPort(5173), page: "crowd.html", onEmit: recorder?.event });
    cleanups.push(() => dash!.close());
  }
  const emit = (e: CrowdEvent) => dash?.emit(e);
  const name = (i: number) => String.fromCharCode(65 + i);
  const dir = mkdtempSync(join(tmpdir(), "bf-crowd-"));
  /** Token files per agent: round 1, then the uneven round. */
  const tokenFiles = [owners.map((_, i) => join(dir, `agent-${i}.json`)), owners.map((_, i) => join(dir, `agent-${i}-r2.json`))];
  const fileCents = (f: string) => existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).proofs as { amount: number }[]).reduce((t, p) => t + p.amount, 0) : 0;
  const emitTokens = () => emit({ type: "tokens", cents: owners.map((_, i) => fileCents(tokenFiles[0][i]) + fileCents(tokenFiles[1][i])) });
  let round2Slot = Number.MAX_SAFE_INTEGER;
  const emitFeed = async () => emit({ type: "feed", earnedBase: String((await tokenBalance(connection, payoutAta))), vaultBase: String((await tokenBalance(connection, vaultToken)) - vaultStart) });
  const watcher = new ChainWatcher({
    connection, accounts: [payoutAta, vaultToken], usdcMint, vaultToken, sinceSlot: startSlot, intervalMs: 1500,
    onObservation: (o) => {
      emit({ type: "chain", kind: o.kind, from: o.from, amountBase: String(o.amountBase), memo: o.memo, time: o.time?.toISOString() ?? null, url: explorerTx(o.signature, rpc), round: o.slot >= round2Slot ? 2 : 1 });
      if (o.kind === "direct_payment") {
        const sig = infer(watcher.observations);
        emit({ type: "exact", signals: sig.map((x) => ({ payer: x.payer, token: x.token, calls: x.calls, totalBase: String(x.totalBase), action: x.action })) });
      }
      void emitFeed();
    },
  });
  if (dash) watcher.start();
  cleanups.push(() => watcher.stop());
  const copycat = (text: string) => console.log(`  ${bold(magenta("Copycat"))}  ${text}`);
  const captions = ["The crowd", "The crowd pays with standard x402", "The crowd funds Blindfold", "The same research, paid with Blindfold",
    "One payout for everyone", "Odd amounts give a depositor away", "Copycat's report"];
  const scene = (n: number, title: string, subtitle: string) => {
    act(`${n}. ${title}`, subtitle);
    emit({ type: "act", n, title: captions[n] });
  };

  blank();
  say(bold("The crowd"));
  for (let i = 0; i < N; i++) kv(`Agent ${name(i)}`, `researches ${TOPICS[i].toUpperCase()}: ${PLANS[i].map((p) => (p === "d" ? "depth" : "whale flow")).join(", ")}`);
  say(dim(`Each agent has its own owner wallet, funded separately before Copycat starts watching. ${FEED} sells whale flow at ${PRICE} cents and depth at ${DEPTH_PRICE} cents.`));
  const payers = await Promise.all(exactAgents.map((k) => exactPayFetch({ keypair: k.secretKey, rpcUrl: rpc, usdcMint: usdcMint.toBase58() })));
  if (dash) {
    blank();
    say(`${bold("Live dashboard:")} ${dash.url}  ${dim("(open it next to this terminal)")}`);
  }
  emit({
    type: "setup", mode: "localnet", prices: { whaleFlow: PRICE, depth: DEPTH_PRICE },
    agents: owners.map((o, i) => ({ name: name(i), token: TOPICS[i].toUpperCase(), wallet: payers[i].address, owner: o.publicKey.toBase58() })),
  });
  emit({ type: "act", n: 0, title: captions[0] });
  void emitFeed();
  await pause(pausing);

  // ---------------------------------------------------------------- 1. the crowd pays with exact
  scene(1, "The crowd pays with standard x402", "Each agent pays from its own wallet; the calls are interleaved, as they would be on a busy feed.");
  const exactSigs: string[] = [];
  for (const { agent, path } of schedule()) {
    // Spaced so repeated identical payments from one wallet get fresh blockhashes.
    await sleep(700);
    const res = await payers[agent].fetch(apiUrl + path);
    const pr = paymentResponse(res);
    if (res.status !== 200 || !pr?.transaction) fail(`exact call failed: HTTP ${res.status} ${await res.text()}`);
    exactSigs.push(pr.transaction);
    ok(`Agent ${name(agent)} paid ${cents(path)} cents for ${label(path)}  ${dim(short(payers[agent].address))}`);
    emit({ type: "call", side: "exact", agent, label: label(path), cents: cents(path), url: explorerTx(pr.transaction, rpc) });
  }
  step("Copycat is scanning the feed's USDC account");
  await watcher.waitFor((o) => exactSigs.every((x) => o.some((y) => y.signature === x)), 90_000);
  const signals = infer(watcher.observations);
  blank();
  for (const s of signals) copycat(`${bold(red(s.action.padEnd(9)))} ${s.reason}`);
  const attributed = signals.filter((s) => s.token && payers.some((p, i) => p.address === s.payer && s.token === TOPICS[i].toUpperCase())).length;
  if (attributed !== N) fail(`Copycat attributed ${attributed} of ${N} agents with exact`);
  emit({ type: "exact", signals: signals.map((x) => ({ payer: x.payer, token: x.token, calls: x.calls, totalBase: String(x.totalBase), action: x.action })), final: true });
  say(`Interleaving did not help: every payment names its wallet, so Copycat sorts them per agent. ${N} of ${N} agents attributed, wallet and token.`);
  await pause(pausing);

  // ---------------------------------------------------------------- 2. the crowd funds Blindfold
  scene(2, "The crowd switches to Blindfold", `Each owner deposits the same ${usd(centsToBaseUnits(DEPOSIT_CENTS))} into the vault, in no particular order.`);
  const deposits: string[] = [];
  const fund = async (i: number, depositCents: number, tokenFile: string, stateDir: string) => {
    const funded = await ownerFund({
      mintUrl, cents: depositCents, tokenFile, stateDir, pollMs: 1000, timeoutMs: 180_000,
      depositor: new SolanaDepositor({ rpcUrl: rpc, owner: owners[i], programId, usdcMint }),
    });
    ok(`owner ${short(owners[i].publicKey.toBase58())} deposited ${usd(centsToBaseUnits(depositCents))}; Agent ${name(i)} holds ${funded.proofs} tokens`);
    emitTokens();
    return funded.depositTx;
  };
  for (const i of shuffle([...Array(N).keys()])) deposits.push(await fund(i, DEPOSIT_CENTS, tokenFiles[0][i], join(dir, `owner-${i}`)));
  say("Equal amounts matter: a distinctive deposit is a fingerprint, and a deposit too small to cover a payout rules its owner out (act 5 shows this).");
  await pause(pausing);

  // ---------------------------------------------------------------- 3. the same research with tokens
  scene(3, "The same research, paid with Blindfold", "Same agents, same tokens, same interleaving. Each payment is an ecash token in an HTTP header.");
  const knownBefore = watcher.observations.length;
  const buy = async (files: string[], plan: { agent: number; path: string }[]) => {
    const wallets = await Promise.all(files.map((f) => AgentWallet.open({ tokenFile: f, maxPerCallCents: DEPTH_PRICE, usdcMint: usdcMint.toBase58() })));
    let total = 0;
    try {
      for (const { agent, path } of plan) {
        await sleep(300);
        const res = await wallets[agent].payFetch(apiUrl + path);
        if (res.status !== 200) fail(`Blindfold call failed: HTTP ${res.status} ${await res.text()}`);
        total += cents(path);
        ok(`Agent ${name(agent)} paid ${cents(path)} cents for ${label(path)}  ${dim("(token, no transaction)")}`);
        emit({ type: "call", side: "blindfold", agent, label: label(path), cents: cents(path) });
      }
    } finally {
      wallets.forEach((w) => w.close());
    }
    emitTokens();
    return total;
  };
  const spent = await buy(tokenFiles[0], schedule());
  await watcher.waitFor((o) => deposits.every((x) => o.some((y) => y.signature === x)), 60_000);
  const fresh = watcher.observations.slice(knownBefore).filter((o) => o.kind === "direct_payment");
  if (fresh.length) fail(`Copycat saw ${fresh.length} direct payments during the Blindfold calls`);
  blank();
  copycat(`${bold(green("NO SIGNAL"))} ${spent} cents of purchases, 0 new transactions at the feed.`);
  emit({ type: "vault", round: 1, action: "NO SIGNAL", reason: `${spent} cents of purchases, 0 transactions at the feed.`, forced: [] });
  await pause(pausing);

  // ---------------------------------------------------------------- 4. one settlement batch
  scene(4, "One settlement pays the feed for everyone", "The mint pays what the feed is owed in one vault transaction.");
  say(dim("To keep this run short the mint settles on request and pays in full. A deployed mint pays at its next fixed window, after a hold, in rounded amounts (pnpm demo, Act 4); that hides timing, not who deposited."));
  const settle = async (expectedCents: number) => {
    const before = await tokenBalance(connection, payoutAta);
    const settled = await admin_("/v1/blindfold/admin/settle", {});
    if (settled.status !== 200) fail(`settlement failed: ${JSON.stringify(settled.json)}`);
    const got = (await tokenBalance(connection, payoutAta)) - before;
    if (got !== centsToBaseUnits(expectedCents)) fail(`feed received ${usd(got)}, expected ${usd(centsToBaseUnits(expectedCents))}`);
    await watcher.waitFor((o) => o.some((y) => y.signature === settled.json.tx), 60_000);
    return got;
  };
  const paid = await settle(spent);
  const delta = (await tokenBalance(connection, vaultToken)) - vaultStart;
  if (delta !== centsToBaseUnits(N * DEPOSIT_CENTS) - paid) fail(`vault moved ${usd(delta)}, expected ${usd(centsToBaseUnits(N * DEPOSIT_CENTS) - paid)}`);
  ok(`the feed received ${usd(paid)} in one transaction; books: vault +${usd(centsToBaseUnits(N * DEPOSIT_CENTS))} - ${usd(paid)} = +${usd(delta)}`);
  const reading = attributeVault(watcher.observations);
  blank();
  for (const o of watcher.observations.filter((x) => x.kind !== "direct_payment")) say(dim(describeTx(o)));
  copycat(`${bold(reading.action === "CANNOT ATTRIBUTE" ? green(reading.action) : red(reading.action))}`);
  copycat(reading.reason);
  if (reading.action !== "CANNOT ATTRIBUTE") fail(`expected CANNOT ATTRIBUTE, Copycat said ${reading.action}`);
  emit({ type: "vault", round: 1, action: reading.action, reason: reading.reason, forced: reading.forced });
  await pause(pausing);

  // ---------------------------------------------------------------- 5. odd amounts
  scene(5, "What breaks it: odd amounts", `A second round. Agent A's owner deposits ${usd(centsToBaseUnits(BIG_CENTS))}; the others deposit ${usd(centsToBaseUnits(SMALL_CENTS))} each. Each agent spends only this round's tokens.`);
  // The first slot after everything round 1 put onchain: the settlement can sit in the current confirmed slot, and
  // any new transaction lands in a later one.
  round2Slot = Math.max(await connection.getSlot(SOLANA_COMMITMENT), ...watcher.observations.map((o) => o.slot)) + 1;
  const deposits2: string[] = [];
  for (const i of shuffle([...Array(N).keys()])) {
    deposits2.push(await fund(i, i === 0 ? BIG_CENTS : SMALL_CENTS, tokenFiles[1][i], join(dir, `owner-${i}-r2`)));
  }
  // Funding is done; on-demand settlement syncs providers itself, so the mint's background jobs can stop.
  stopJobs();
  const plan2 = [...BIG_PLAN.map((p) => ({ agent: 0, path: `/v1/data/${TOPICS[0]}${p === "d" ? "/depth" : ""}` })), ...[...Array(N).keys()].slice(1).map((i) => ({ agent: i, path: `/v1/data/${TOPICS[i]}` }))];
  const spent2 = await buy(tokenFiles[1], shuffle(plan2));
  await settle(spent2);
  await watcher.waitFor((o) => deposits2.every((x) => o.some((y) => y.signature === x)), 60_000);
  // Copycat assumes this round's payout was funded by this round's deposits. Older tokens widen the real crowd;
  // here the agents spent only this round's tokens, so the guess is right.
  const reading2 = attributeVault(watcher.observations.filter((o) => o.slot >= round2Slot));
  blank();
  copycat(`${bold(red(reading2.action))}`);
  copycat(reading2.reason);
  if (reading2.action !== "PARTIAL" || reading2.forced[0] !== owners[0].publicKey.toBase58()) fail(`expected PARTIAL naming Agent A's owner, Copycat said ${reading2.action}`);
  emit({ type: "vault", round: 2, action: reading2.action, reason: reading2.reason, forced: reading2.forced });
  say(`The small deposits hold ${usd(centsToBaseUnits(SMALL_CENTS * (N - 1)))} together, less than the ${usd(reading2.payoutBase)} payout, so the big depositor must have bought from ${FEED}. The token stays hidden; the wallet does not. Boring, equal amounts avoid this.`);
  await pause(pausing);

  // ---------------------------------------------------------------- 6. the report
  scene(6, "Copycat's report", "The same crowd and the same purchases, paid two ways.");
  blank();
  say(bold(red("Standard x402 (exact)")));
  for (const [i, s] of signals.map((x) => [payers.findIndex((p) => p.address === x.payer), x] as const).sort((a, b) => a[0] - b[0])) {
    kv(`Agent ${name(i)}`, `${short(s.payer)}  ${s.calls} calls, ${usd(s.totalBase)}, ${s.token ?? "?"}: ${s.action}`);
  }
  blank();
  say(bold(green("Blindfold x402 (blindfold), equal deposits")));
  for (const d of reading.depositors) kv("Agent ?", `${short(d.wallet)}  deposited ${usd(d.totalBase)}; bought: unknown; token: unknown`);
  kv("Payout", `${usd(reading.payoutBase)} from the vault to ${FEED} in one batch`);
  kv("Verdict", bold(green(reading.action)));
  // The same payout with only one depositor in view: what a crowd of one gives away.
  const alone = attributeVault(watcher.observations.filter((o) => o.slot < round2Slot && (o.kind === "vault_payout" || o.signature === deposits[0])));
  say(dim(`With a crowd of one, the same payout would read: ${alone.action}. ${alone.reason}`));
  blank();
  say(bold(yellow("Blindfold x402 (blindfold), odd amounts")));
  kv("Verdict", `${bold(red(reading2.action))}: ${short(reading2.forced[0])} bought from ${FEED}; token: unknown`);
  blank();
  say(bold("What still leaks"));
  say(yellow("- Funding: if the owners' USDC came from one wallet, that transfer links them. Here each was funded on its own, before Copycat started watching."));
  say(yellow("- Amounts: odd or uneven deposits can single out a depositor, as act 5 showed."));
  say(yellow("- Size: the payout total bounds the crowd's spending, and the feed's revenue is public."));
  say(yellow("- Timing: deposits right before a payout, or one owner's deposits always followed by large payouts, can be correlated over time."));
  say(yellow("- The feed and the mint: the feed sees the queries and IP addresses; the mint sees redemption amounts and times."));
}

let failed = false;
process.once("SIGINT", () => { failed = true; void cleanup().then(() => process.exit(130)); });
async function cleanup() {
  for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
  cleanups.length = 0;
}
try {
  await main();
  blank();
  console.log(green(bold("Crowd demo complete.")));
  dashboard?.emit({ type: "done", ok: true });
  // Keep the final dashboard on screen for recording.
  if (dashboard) await pause(pausing, `Dashboard still live at ${dashboard.url}. Press Enter to exit`);
} catch (e) {
  failed = true;
  blank();
  console.error(red(`Crowd demo stopped: ${(e as Error).message}`));
  if (!(e as { demo?: boolean }).demo) console.error(dim((e as Error).stack ?? ""));
  dashboard?.emit({ type: "done", ok: false });
}
await cleanup();
if (recorder) { recorder.stop(); recorder.save(); console.log(dim(`Recording saved to ${argv[recordArg + 1]}; preview it with: pnpm replay ${argv[recordArg + 1]}`)); }
process.exit(failed ? 1 : 0);
