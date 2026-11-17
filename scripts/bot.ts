// Copycat, standalone: a front-running bot that watches a data provider's USDC account and the Blindfold vault
// using only public Solana data, prints what each transaction reveals and the trading signal it infers. New
// transactions arrive through a QuickNode Stream (webhook over a cloudflared quick tunnel) when .keys/quicknode.json
// exists, with RPC polling as the fallback. Run it in a second terminal next to `pnpm demo`.
//
//   pnpm bot                         devnet, provider payout account from .keys/provider-payout.json
//   pnpm bot --account <token-acct>  watch any USDC token account
//   pnpm bot --once                  print what is visible from the last 20 transactions and exit
//   pnpm bot --rpc                   poll RPC only, no QuickNode Stream
//   pnpm bot --no-history            skip the initial RPC scan and only report new transactions
//
// Env: SOLANA_RPC_URL (default devnet), VAULT_PROGRAM_ID, USDC_MINT, KEYS_DIR, STREAMS_WEBHOOK_URL + STREAMS_PORT
// (your own tunnel instead of cloudflared).
import "./lib/quiet.js";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey } from "@solana/web3.js";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT } from "@blindfold/protocol";
import type { Observation } from "./lib/bot.js";
import { describe, infer } from "./lib/copycat.js";
import { StreamWatcher } from "./lib/streamWatcher.js";
import { defaultWatch, loadApiKey } from "./lib/streams.js";
import { explorerTx } from "./lib/explorer.js";
import { act, bold, dim, green, magenta, red, say, short } from "./lib/narrate.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const once = argv.includes("--once");
const rpcOnly = argv.includes("--rpc");
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
const keys = process.env.KEYS_DIR ?? fileURLToPath(new URL("../.keys", import.meta.url));

const connection = new Connection(rpc, SOLANA_COMMITMENT);
const a = flag("--account");
const watch = defaultWatch({ keysDir: keys, usdcMint, programId, ...(a ? { account: new PublicKey(a) } : {}) });
const account = new PublicKey(watch.tokenAccounts[0]);
const vaultToken = new PublicKey(watch.vaultToken);
const apiKey = loadApiKey(keys);
const noHistory = argv.includes("--no-history");
const time = (o: Observation) => (o.time ? o.time.toISOString().slice(11, 19) : "--:--:--");

const signals = new Map<string, string>();

function report(o: Observation, all: Observation[]) {
  const label = o.kind === "direct_payment" ? red(bold("PAYMENT     ")) : o.kind === "vault_payout" ? green(bold("VAULT PAYOUT")) : green(bold("VAULT DEPOSIT"));
  console.log(`${time(o)}  ${label}  ${describe(o)}  ${dim(o.via === "streams" ? "via QuickNode Streams" : "via RPC")}`);
  say(dim(explorerTx(o.signature, rpc)));
  if (o.kind !== "direct_payment") {
    console.log(`          ${bold(magenta("Copycat"))}  ${green(bold("NO SIGNAL"))}  ${dim("nothing here names an agent")}`);
    return;
  }
  const s = infer(all).find((x) => x.payer === o.from);
  if (!s || signals.get(s.payer) === s.reason) return;
  signals.set(s.payer, s.reason);
  console.log(`          ${bold(magenta("Copycat"))}  ${red(bold(s.action))}  ${s.reason}`);
}

act("Copycat", `A front-running bot reading public Solana data only. Feed account ${short(account.toBase58())}, vault ${short(vaultToken.toBase58())}.`);
// Starts from recent history (the last 20 transactions per account, over RPC: a free-plan Stream only follows the
// chain tip), then reports new ones as they land.
const watcher = new StreamWatcher({
  connection, accounts: [account, vaultToken], usdcMint, vaultToken, vaultProgram: programId, intervalMs: 4000,
  ...(noHistory ? { sinceSlot: await connection.getSlot(SOLANA_COMMITMENT) } : {}),
  streams: once || rpcOnly || !apiKey ? null : {
    apiKey, ...(process.env.STREAMS_WEBHOOK_URL ? { webhookUrl: process.env.STREAMS_WEBHOOK_URL, port: Number(process.env.STREAMS_PORT ?? 8787) } : {}),
  },
  onObservation: (o) => report(o, watcher.observations),
  onStatus: (_, detail) => console.log(dim(`[source] ${detail}`)),
  onDeposit: (d) => say(dim(`vault DepositMade #${d.index}: $${(Number(d.amount) / 1e6).toFixed(2)} (from the Stream's decoded event)`)),
});
if (!noHistory) await watcher.scan().catch((e) => console.error(dim(`RPC error: ${(e as Error).message}`)));
if (watcher.observations.length === 0) console.log(dim("nothing yet; waiting for transactions..."));
if (once) process.exit(0);
if (!apiKey && !rpcOnly) console.log(dim("[source] no .keys/quicknode.json; polling RPC (see docs/DEMO.md, QuickNode Streams)"));
watcher.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => { void watcher.stop().finally(() => process.exit(0)); });
}
