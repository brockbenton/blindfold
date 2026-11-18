// The live Blindfold stack on this machine, against the deployed devnet vault: PostgreSQL, the mint (real chain,
// settling on its normal schedule), TokenFeed (with the standard x402 `exact` baseline), NewsWire and the gateway
// (docs/design/06-gateway.md) when their keys exist, and cloudflared quick tunnels so wallets elsewhere can reach them. Unlike `pnpm demo`, the mint keeps its database and seed between runs, so tokens funded today still
// redeem tomorrow and the vault's history (scripts/vault-history) keeps growing.
//
//   pnpm serve                 tunnels for the mint and the feeds (needs cloudflared)
//   pnpm serve --local         no tunnels: http://localhost only, with a stable mint URL across restarts
//   pnpm serve --window 600    settlement window and hold in seconds (default 600, the mint's production default)
//
// Env: SOLANA_RPC_URL (a private devnet RPC avoids rate limits), DATABASE_URL (default: the repository's dev
// PostgreSQL), KEYS_DIR (default .keys), SERVE_MINT_URL / SERVE_FEED_URL / SERVE_NEWS_URL (your own stable public
// URLs, e.g. a named Cloudflare tunnel to the local port; skips the quick tunnel for that service), and
// SERVE_GATEWAY_URL likewise for the gateway.
// Refuses to start while a devnet `pnpm demo` or another `pnpm serve` holds the settlement lock.
import "./lib/quiet.js";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import pg from "pg";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, configPda, decodeConfig, decodeProviderRecord, providerPda, vaultAta } from "@blindfold/protocol";
import { getPubKeyFromPrivKey } from "@cashu/cashu-ts";
import { createApp } from "../apps/mock-api/src/app.js";
import { marketSourceFromEnv } from "../apps/mock-api/src/data/liveMarket.js";
import { exactFacilitator } from "../apps/mock-api/src/x402/exactBaseline.js";
import { HttpKeysetSource } from "../apps/mock-api/src/x402/keysets.js";
import { createGateway } from "../apps/gateway/src/app.js";
import { standInRoutes } from "../apps/gateway/src/routes.js";
import { UpstreamClient } from "../apps/gateway/src/upstream.js";
import { loadOrCreateKeypair, walletPayFetch } from "../apps/gateway/src/wallet.js";
import { HttpRedeemClient } from "../apps/mock-api/src/x402/redeemClient.js";
import { SolanaSettleSender } from "../services/mint/src/chain/settleSender.js";
import { SolanaVaultReader } from "../services/mint/src/chain/vaultReader.js";
import type { AppConfig } from "../services/mint/src/config.js";
import { createPool } from "../services/mint/src/db.js";
import { createMint as createMintServer } from "../services/mint/src/mint.js";
import { explorerAddress } from "./lib/explorer.js";
import { act, blank, bold, dim, green, kv, ok, say, step, usd, warn, yellow } from "./lib/narrate.js";
import { acquireSettleLock } from "./lib/settleLock.js";
import { cloudflaredBin, startTunnel, type Tunnel } from "./lib/streams.js";

const argv = process.argv.slice(2);
const local = argv.includes("--local");
const windowArg = argv.indexOf("--window");
const WINDOW_S = windowArg >= 0 ? Number(argv[windowArg + 1]) : 600;
if (!Number.isInteger(WINDOW_S) || WINDOW_S < 10 || WINDOW_S > 86_400) throw new Error("--window must be an integer from 10 to 86400");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEYS = process.env.KEYS_DIR ?? join(ROOT, ".keys");
const SCHEMA = "serve";
const PRICE = 5, DEPTH_PRICE = 10, SIGNALS_PRICE = 25, NEWS_PRICE = 5, UNIT_CENTS = 10;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const cleanups: (() => Promise<void> | void)[] = [];

function fail(message: string): never {
  throw Object.assign(new Error(message), { serve: true });
}
const loadKeypair = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
function keyFile(name: string): Keypair {
  const p = join(KEYS, `${name}.json`);
  if (!existsSync(p)) fail(`missing ${p}. Restore .keys/ from your backup (see docs/DEMO.md).`);
  return loadKeypair(p);
}
/** A secret kept in the keys directory, created on first use. Stable values keep the mint consistent across runs. */
function persistent(name: string, make: () => string): string {
  const p = join(KEYS, name);
  if (!existsSync(p)) {
    writeFileSync(p, make(), { mode: 0o600 });
    warn(`created ${p}; add it to your key backup (the mint's tokens depend on it)`);
  }
  return readFileSync(p, "utf8").trim();
}
async function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer().once("error", () => res(false)).listen(port, "127.0.0.1", () => s.close(() => res(true)));
  });
}
async function needPort(port: number, what: string) {
  if (!(await portFree(port))) fail(`port ${port} (${what}) is in use. Stop whatever runs there, e.g. another demo or serve.`);
  return port;
}
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  step("starting the repository's local PostgreSQL (services/mint/scripts/dev-pg.sh)");
  return execFileSync(join(ROOT, "services/mint/scripts/dev-pg.sh"), { encoding: "utf8" }).trim().split("\n").pop()!;
}
/** Requests as the public URL sees them, so x402 resource URLs name the public origin (not localhost:port). */
function atPublicUrl(app: { fetch: (req: Request) => Response | Promise<Response> }, publicUrl: string) {
  const base = new URL(publicUrl);
  return (req: Request) => {
    const u = new URL(req.url);
    u.protocol = base.protocol;
    u.hostname = base.hostname;
    u.port = base.port;
    return app.fetch(new Request(u, req));
  };
}
function newsData(topic: string) {
  const t = topic.toUpperCase();
  const headlines = [`${t} developer activity hits a monthly high`, `Exchange reserves of ${t} edge lower`, `Analysts split on ${t} after a quiet week`];
  return { topic: t, headline: headlines[Math.floor(Math.random() * headlines.length)], sentiment: Number((Math.random() * 2 - 1).toFixed(2)), as_of: new Date().toISOString() };
}

async function main() {
  act("Blindfold, live", local ? "The mint and feeds on this machine (local only)." : "The mint and feeds on this machine, reachable from anywhere through cloudflared.");
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  if (/mainnet/i.test(rpc)) fail("refusing to run against mainnet");
  if (!process.env.SOLANA_RPC_URL) say(yellow("Using the public devnet RPC, which rate-limits. Set SOLANA_RPC_URL to a free Helius or QuickNode devnet URL for a steadier mint."));
  if (!existsSync(KEYS)) fail(`${KEYS} not found. Restore your key backup into it (see docs/DEMO.md).`);
  cleanups.push(acquireSettleLock(KEYS, "pnpm serve"));

  const connection = new Connection(rpc, SOLANA_COMMITMENT);
  if (!(await connection.getGenesisHash()).startsWith(SOLANA_DEVNET_CAIP2.split(":")[1])) fail("the RPC is not Solana devnet");
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
  const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
  const authority = keyFile("mint-authority");
  step(`checking the vault at ${programId.toBase58()}`);
  const cfgInfo = await connection.getAccountInfo(configPda(programId));
  if (!cfgInfo) fail(`vault Config not found for ${programId.toBase58()} on the configured RPC`);
  const config = decodeConfig(cfgInfo.data);
  if (!config.mintAuthority.equals(authority.publicKey)) fail("mint-authority.json does not match the vault's mint authority");
  if (!config.usdcMint.equals(usdcMint)) fail("USDC mint does not match the vault");
  const authSol = (await connection.getBalance(authority.publicKey, SOLANA_COMMITMENT)) / LAMPORTS_PER_SOL;
  if (authSol < 0.01) warn(`the mint authority has ${authSol} SOL; settlement needs fees (faucet.solana.com, ${authority.publicKey.toBase58()})`);

  // The feeds: TokenFeed always, NewsWire when its keys exist and it is registered (pnpm demo registers it once).
  const findProvider = async (secret: string) => {
    const pubkey = hex(getPubKeyFromPrivKey(Buffer.from(secret, "hex")));
    for (let id = 0; id < config.providerCount; id++) {
      const info = await connection.getAccountInfo(providerPda(id, programId));
      if (!info) continue;
      const rec = decodeProviderRecord(info.data);
      if (rec.active && hex(rec.cashuPubkey) === pubkey) return id;
    }
    return null;
  };
  const feedSecretPath = join(KEYS, "provider-secret.hex");
  if (!existsSync(feedSecretPath)) fail(`missing ${feedSecretPath}`);
  const feedSecret = readFileSync(feedSecretPath, "utf8").trim();
  const feedId = await findProvider(feedSecret);
  if (feedId === null) fail("no active vault provider uses .keys/provider-secret.hex");
  const newsSecretPath = join(KEYS, "news-secret.hex");
  const newsSecret = existsSync(newsSecretPath) ? readFileSync(newsSecretPath, "utf8").trim() : null;
  const newsId = newsSecret ? await findProvider(newsSecret) : null;
  if (newsId === null) say(dim("NewsWire is not registered yet (run pnpm demo once); serving without it."));
  // The gateway: its provider key and shared wallet from `pnpm gateway:setup`, and a vault registration.
  const gatewaySecretPath = join(KEYS, "gateway-secret.hex");
  const gatewayWalletPath = join(KEYS, "gateway-wallet.json");
  const gatewaySecret = existsSync(gatewaySecretPath) && existsSync(gatewayWalletPath) ? readFileSync(gatewaySecretPath, "utf8").trim() : null;
  const gatewayId = gatewaySecret ? await findProvider(gatewaySecret) : null;
  if (gatewaySecret && gatewayId === null) warn("the gateway's key is not an active vault provider; run pnpm gateway:setup. Serving without the gateway.");
  else if (!gatewaySecret) say(dim("No gateway keys (pnpm gateway:setup creates them); serving without the gateway."));
  // TokenFeed also sells over standard x402 `exact` (the gateway's devnet stand-in vendor buys there).
  const payoutPath = join(KEYS, "provider-payout.json");
  const facilitatorPath = join(KEYS, "facilitator.json");
  const exactOn = existsSync(payoutPath) && existsSync(facilitatorPath);
  if (!exactOn) warn("no .keys/provider-payout.json or facilitator.json: TokenFeed serves Blindfold only (no exact baseline, so the gateway's stand-in vendor cannot sell)");

  const [mintPort, feedPort] = [await needPort(3338, "mint"), await needPort(4000, "TokenFeed")];
  const newsPort = newsId !== null ? await needPort(4001, "NewsWire") : null;
  const gatewayPort = gatewayId !== null && exactOn ? await needPort(4100, "gateway") : null;
  const localMint = `http://localhost:${mintPort}`;

  // Public URLs: your own (SERVE_*_URL), a quick tunnel, or localhost with --local. Tunnels start before the
  // servers because the mint advertises the feeds' URLs and the feeds advertise the mint's.
  const tunnel = async (port: number, own: string | undefined, what: string): Promise<string> => {
    if (own) return own.replace(/\/$/, "");
    if (local) return `http://localhost:${port}`;
    const t: Tunnel = await startTunnel(port, 60_000).catch((e) => fail(`${what} tunnel: ${(e as Error).message}. Use --local, or set SERVE_${what.toUpperCase()}_URL.`));
    cleanups.push(() => t.close());
    return t.url;
  };
  if (!local && !cloudflaredBin() && !(process.env.SERVE_MINT_URL && process.env.SERVE_FEED_URL)) {
    fail("cloudflared not found. Install it (docs/DEMO.md, QuickNode Streams), or run pnpm serve --local.");
  }
  if (!local) step("opening cloudflared tunnels (10 to 60 seconds)");
  const tunnels = await Promise.allSettled([
    tunnel(mintPort, process.env.SERVE_MINT_URL, "mint"),
    tunnel(feedPort, process.env.SERVE_FEED_URL, "feed"),
    newsPort !== null ? tunnel(newsPort, process.env.SERVE_NEWS_URL, "news") : Promise.resolve(null),
    gatewayPort !== null ? tunnel(gatewayPort, process.env.SERVE_GATEWAY_URL, "gateway") : Promise.resolve(null),
  ]);

  const [mintUrl, feedUrl, newsUrl, gatewayUrl] = tunnels.map((t) => {
    if (t.status === "rejected") throw t.reason;
    return t.value;
  }) as [string, string, string | null, string | null];

  // The mint: a stable schema and seed, so balances, spent proofs and the deposit cursor survive restarts.
  const dbUrl = databaseUrl();
  const adminPool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  await adminPool.query(`create schema if not exists ${SCHEMA}`);
  await adminPool.end();
  const db = createPool(dbUrl, SCHEMA);
  cleanups.push(() => db.end());
  const seed = persistent("serve-mint-seed.hex", () => randomBytes(32).toString("hex"));
  const adminToken = persistent("serve-admin-token", () => randomBytes(24).toString("hex"));
  const topics = ["sol", "btc", "eth"];
  const cfg: AppConfig = {
    SOLANA_RPC_URL: rpc, VAULT_PROGRAM_ID: programId.toBase58(), USDC_MINT: usdcMint.toBase58(), MINT_URL: mintUrl,
    DATABASE_URL: dbUrl, MINT_SEED: seed, MINT_AUTHORITY_KEYPAIR: "", MINT_ADMIN_TOKEN: adminToken, PORT: mintPort,
    providers: [
      { provider_id: feedId, name: "token-feed", url: feedUrl, price_cents: PRICE, topics },
      ...(newsId !== null && newsUrl ? [{ provider_id: newsId, name: "news-wire", url: newsUrl, price_cents: NEWS_PRICE, topics }] : []),
      ...(gatewayId !== null && gatewayUrl ? [{ provider_id: gatewayId, name: "Gateway", url: gatewayUrl, price_cents: PRICE, topics }] : []),
    ],
    depositPollMs: 2000, settleIntervalS: WINDOW_S, settleHoldS: WINDOW_S, settleUnitCents: UNIT_CENTS, devFakeChain: false,
  };
  step("starting the mint (database schema \"serve\", kept between runs)");
  const { app: mintApp, start } = await createMintServer({
    db, cfg, vault: new SolanaVaultReader(connection, programId, usdcMint),
    sender: new SolanaSettleSender(connection, programId, usdcMint, authority), confirmTimeoutMs: 90_000,
  });
  const stopJobs = start();
  cleanups.push(() => stopJobs());
  const stop = (s: ReturnType<typeof serve>) => new Promise<void>((r) => { (s as any).closeAllConnections?.(); s.close(() => r()); });
  const mintServer = serve({ fetch: mintApp.fetch, port: mintPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(mintServer));

  // The feeds advertise the public mint URL (wallets check it against their token file) but redeem locally.
  const feedLog = (name: string) => (e: Record<string, unknown>) => {
    if (e.outcome === "owed") console.error(JSON.stringify(e));
    else if (e.outcome === "served") ok(`${name} served ${e.route} (paid)`);
    else if (e.outcome && e.outcome !== "challenge") say(dim(`${name} ${e.route}: ${e.outcome}${e.reason ? ` (${e.reason})` : ""}`));
  };
  step(`starting TokenFeed${exactOn ? " (Blindfold and the exact baseline)" : ""}`);
  const exact = exactOn
    ? { payTo: loadKeypair(payoutPath).publicKey.toBase58(), facilitator: await exactFacilitator({ keypair: loadKeypair(facilitatorPath).secretKey, rpcUrl: rpc }) } // ExactSvmScheme adds a random memo when the seller does not prescribe one.
    : undefined;
  const facSol = exactOn ? (await connection.getBalance(loadKeypair(facilitatorPath).publicKey, SOLANA_COMMITMENT)) / LAMPORTS_PER_SOL : 1;
  if (facSol < 0.01) warn(`the exact facilitator has ${facSol} SOL; exact payments need fees (it pays them)`);
  const feed = createApp({
    mintUrl, providerSecretKey: feedSecret, priceCents: PRICE, depthPriceCents: DEPTH_PRICE, signalsPriceCents: SIGNALS_PRICE,
    usdcMint: usdcMint.toBase58(), providerId: feedId, redeem: new HttpRedeemClient(localMint), keysets: new HttpKeysetSource(localMint), log: feedLog("TokenFeed"),
    exact, market: marketSourceFromEnv(), // live Coinbase data unless MARKET_DATA=mock
  });
  const feedServer = serve({ fetch: atPublicUrl(feed, feedUrl), port: feedPort, hostname: "127.0.0.1" });
  cleanups.push(() => stop(feedServer));
  if (newsId !== null && newsSecret && newsPort !== null && newsUrl) {
    step("starting NewsWire");
    const news = createApp({
      mintUrl, providerSecretKey: newsSecret, priceCents: NEWS_PRICE, usdcMint: usdcMint.toBase58(), providerId: newsId,
      redeem: new HttpRedeemClient(localMint), keysets: new HttpKeysetSource(localMint), log: feedLog("NewsWire"),
      dataHandler: (c, topic) => c.json(newsData(topic)),
    });
    const newsServer = serve({ fetch: atPublicUrl(news, newsUrl), port: newsPort, hostname: "127.0.0.1" });
    cleanups.push(() => stop(newsServer));
  }

  if (gatewayId !== null && gatewaySecret && gatewayPort !== null && gatewayUrl) {
    step("starting the gateway (resells TokenFeed's exact routes to Blindfold agents)");
    const { bytes } = loadOrCreateKeypair(gatewayWalletPath, false);
    const wallet = await walletPayFetch({ keypair: bytes, rpcUrl: rpc, network: SOLANA_DEVNET_CAIP2, asset: usdcMint.toBase58() });
    const gateway = createGateway({
      mintUrl, providerSecretKey: gatewaySecret, routes: standInRoutes(`http://localhost:${feedPort}`), usdcMint: usdcMint.toBase58(), providerId: gatewayId,
      redeem: new HttpRedeemClient(localMint), keysets: new HttpKeysetSource(localMint), log: feedLog("Gateway"),
      upstream: new UpstreamClient({ payFetch: wallet.payFetch, network: SOLANA_DEVNET_CAIP2, asset: usdcMint.toBase58() }),
    });
    const gatewayServer = serve({ fetch: atPublicUrl(gateway, gatewayUrl), port: gatewayPort, hostname: "127.0.0.1" });
    cleanups.push(() => stop(gatewayServer));
    const walletUsdc = (await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(usdcMint, new PublicKey(wallet.address)), SOLANA_COMMITMENT).catch(() => null))?.value.amount ?? "0";
    if (BigInt(walletUsdc) < 250_000n) warn(`the gateway wallet ${wallet.address} holds ${usd(BigInt(walletUsdc))}; pnpm gateway:setup tops it up`);
  }

  const vaultToken = vaultAta(usdcMint, programId);
  const vaultBase = (await connection.getTokenAccountBalance(vaultToken, SOLANA_COMMITMENT).catch(() => null))?.value.amount ?? "0";
  blank();
  say(bold(green("Blindfold is live.")));
  kv("Mint", mintUrl);
  kv("TokenFeed", `${feedUrl}/v1/data/sol`);
  if (newsUrl) kv("NewsWire", `${newsUrl}/v1/data/sol`);
  if (gatewayUrl) kv("Gateway", `${gatewayUrl}/v1/data/sol  (agent: --provider Gateway)`);
  kv("Vault", `${usd(BigInt(vaultBase))} held · ${explorerAddress(vaultToken.toBase58(), rpc)}`);
  kv("Settlement", `every ${WINDOW_S}s window, after a ${WINDOW_S}s hold, in ${UNIT_CENTS}-cent units`);
  kv("Admin token", join(KEYS, "serve-admin-token"));
  blank();
  const shellWord = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  if (process.env.SOLANA_RPC_URL) say(dim("Set SOLANA_RPC_URL in the terminal where you run these commands."));
  say(dim("Fund an agent (the token file only pays this mint at this URL):"));
  console.log(`  MINT_URL=${shellWord(mintUrl)} OWNER_KEYPAIR=${shellWord(join(KEYS, "owner.json"))} TOKEN_FILE=./tokens.json VAULT_PROGRAM_ID=${programId.toBase58()} USDC_MINT=${usdcMint.toBase58()} \\`);
  console.log(`    node packages/wallet/dist/cli.js fund --cents 50`);
  say(dim("Run the agent against it:"));
  console.log(`  MINT_URL=${shellWord(mintUrl)} TOKEN_FILE=./tokens.json VAULT_PROGRAM_ID=${programId.toBase58()} USDC_MINT=${usdcMint.toBase58()} \\`);
  console.log(`    node agents/simple/dist/main.js --topic sol --calls 2`);
  if (!local && !process.env.SERVE_MINT_URL) say(yellow("Quick tunnel URLs change on every run. Token files funded through this URL stop paying when it goes away; use --local or SERVE_MINT_URL for a stable one."));
  say(dim("Ctrl-C stops everything. The mint's database and seed stay in the \"serve\" schema and .keys/."));

  // A brand-new quick tunnel hostname can take a while to resolve; say when the mint answers publicly.
  if (!local && !process.env.SERVE_MINT_URL) {
    void (async () => {
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`${mintUrl}/v1/info`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (r?.ok) { ok(`public mint URL answers: ${mintUrl}/v1/info`); return; }
        await new Promise((res) => setTimeout(res, 5000));
      }
      warn(`no answer from ${mintUrl} yet; the local mint at ${localMint} still works`);
    })();
  }
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function cleanup() {
  for (const f of cleanups.reverse()) {
    try { await f(); } catch { /* best effort */ }
  }
}

main()
  .then(async () => {
    blank();
    step("stopping");
    await cleanup();
    process.exit(0);
  })
  .catch(async (e) => {
    const rpc = process.env.SOLANA_RPC_URL;
    const message = rpc ? (e as Error).message.replaceAll(rpc, "[Solana RPC]") : (e as Error).message;
    console.error(`\n  ${(e as { serve?: boolean }).serve ? "" : "unexpected error: "}${message}`);
    await cleanup();
    process.exit(1);
  });
