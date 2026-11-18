// Public chain view for the live MCP demo (docs/DEMO.md, "Live demo with Claude and MCP"): Copycat, the front-running
// observer, on a page. It watches the feeds' USDC accounts and the Blindfold vault using only public Solana data
// (QuickNode Streams when .keys/quicknode.json exists, RPC polling otherwise) and streams each transaction and its
// reading to http://localhost:5175. Put the page next to Claude: the rival's `exact` purchases show up with their memo,
// Claude's Blindfold purchases don't show up at all, and the vault shows one deposit and, later, batched payouts.
//
//   pnpm watch                       devnet, the last 30 minutes of history, then live
//   pnpm watch --history 0           start empty (only transactions from now on)
//   pnpm watch --port 5175 --rpc     another port; poll RPC only, no QuickNode Stream
//
// Wallet labels on the page (rival agent, owner) come from .keys/ and are the demo's annotation: Copycat itself only
// sees addresses. A Stream DepositMade event nudges the local mint (MINT_URL, default http://localhost:3338) to poll
// deposits now, with the admin token from MINT_ADMIN_TOKEN or .keys/serve-admin-token; the mint still credits only
// from onchain DepositRecord accounts.
import "./lib/quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT } from "@blindfold/protocol";
import type { Observation } from "./lib/bot.js";
import { startDashboard } from "./lib/dashboard.js";
import { explorerAddress, explorerTx } from "./lib/explorer.js";
import { act, bold, dim, kv, say } from "./lib/narrate.js";
import { attributeVault, describe, infer } from "./lib/observer.js";
import { StreamWatcher } from "./lib/streamWatcher.js";
import { defaultWatch, feedWallets, loadApiKey } from "./lib/streams.js";

/** Events the page (scripts/dashboard/watch.html) renders. */
export type WatchEvent =
  | { type: "setup"; network: string; vault: string; vaultUrl: string; feeds: { name: string; account: string; url: string }[]; labels: Record<string, string> }
  | { type: "source"; state: string; text: string }
  | {
    type: "tx"; kind: Observation["kind"]; signature: string; time: string | null; from: string; to: string; toName: string; amountBase: string;
    memo?: string; text: string; url: string; via?: string;
  }
  | { type: "signal"; payer: string; action: string; reason: string; calls: number; token: string | null; tokenCalls: number; spanSeconds: number | null }
  | { type: "vault"; action: string; reason: string; depositors: number; payouts: number; payoutBase: string };

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const rpcOnly = argv.includes("--rpc");
const historyMin = Number(flag("--history") ?? 30);
if (!Number.isFinite(historyMin) || historyMin < 0) throw new Error("--history must be a number of minutes, 0 or more");
const port = Number(flag("--port") ?? 5175);
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
const keys = process.env.KEYS_DIR ?? fileURLToPath(new URL("../.keys", import.meta.url));
const mintUrl = (process.env.MINT_URL ?? "http://localhost:3338").replace(/\/+$/, "");
const adminFile = join(keys, "serve-admin-token");
const adminToken = process.env.MINT_ADMIN_TOKEN ?? (existsSync(adminFile) ? readFileSync(adminFile, "utf8").trim() : undefined);

const connection = new Connection(rpc, SOLANA_COMMITMENT);
const watch = defaultWatch({ keysDir: keys, usdcMint, programId });
const feeds = feedWallets(keys);
const feedNames = Object.fromEntries(feeds.map((f) => [f.owner.toBase58(), f.name]));
const pubkey = (file: string) => {
  const p = join(keys, file);
  return existsSync(p) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[])).publicKey.toBase58() : null;
};
const labels: Record<string, string> = {};
for (const [file, label] of [
  ["exact-agent.json", "rival"], ["owner.json", "owner"], ["gateway-wallet.json", "gateway"],
] as const) {
  const k = pubkey(file);
  if (k) labels[k] = label;
}

// Slots run at roughly 2.5 per second on devnet; this only bounds the history scan, it is not a coverage claim.
const sinceSlot = Math.max(0, (await connection.getSlot(SOLANA_COMMITMENT)) - Math.round(historyMin * 60 * 2.5));

const dashboard = await startDashboard<WatchEvent>({ port, page: "watch.html" });
dashboard.emit({
  type: "setup", network: rpc.includes("devnet") ? "Solana devnet" : rpc, vault: watch.vaultToken, vaultUrl: explorerAddress(watch.vaultToken, rpc),
  feeds: feeds.map((f, i) => ({ name: f.name, account: watch.tokenAccounts[i], url: explorerAddress(watch.tokenAccounts[i], rpc) })),
  labels,
});

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const time = (o: Observation) => (o.time ? o.time.toISOString().slice(11, 19) : "--:--:--");
const lastSignal = new Map<string, string>();
let lastVault = "";

function report(o: Observation, all: Observation[]) {
  dashboard.emit({
    type: "tx", kind: o.kind, signature: o.signature, time: o.time ? o.time.toISOString() : null, from: o.from, to: o.to,
    toName: o.kind === "vault_deposit" ? "Vault" : feedNames[o.to] ?? short(o.to),
    amountBase: String(o.amountBase), ...(o.memo ? { memo: o.memo } : {}), text: describe(o, feedNames), url: explorerTx(o.signature, rpc), via: o.via,
  });
  console.log(`${time(o)}  ${o.kind.padEnd(14)} ${describe(o, feedNames)}  ${dim(o.via === "streams" ? "via QuickNode Streams" : "via RPC")}`);
  if (o.kind === "direct_payment") {
    const s = infer(all).find((x) => x.payer === o.from);
    if (s && lastSignal.get(s.payer) !== s.reason) {
      lastSignal.set(s.payer, s.reason);
      dashboard.emit({
        type: "signal", payer: s.payer, action: s.action, reason: s.reason, calls: s.calls, token: s.token, tokenCalls: s.tokenCalls, spanSeconds: s.spanSeconds,
      });
      console.log(`          ${bold("Copycat")}  ${s.action}  ${dim(s.reason)}`);
    }
    return;
  }
  const r = attributeVault(all);
  if (r.reason !== lastVault) {
    lastVault = r.reason;
    dashboard.emit({ type: "vault", action: r.action, reason: r.reason, depositors: r.depositors.length, payouts: r.payouts, payoutBase: String(r.payoutBase) });
    console.log(`          ${bold("Copycat")}  ${r.action}  ${dim(r.reason)}`);
  }
}

act("Public chain view", "Copycat reads public Solana data only: the feeds' USDC accounts and the Blindfold vault.");
kv("Page", dashboard.url);
kv("Watching", `${feeds.map((f) => f.name).join(", ")} and the vault ${watch.vaultToken}`);
kv("History", historyMin > 0 ? `the last ${historyMin} minutes (from slot ${sinceSlot})` : "none; new transactions only");
const apiKey = loadApiKey(keys);
const watcher = new StreamWatcher({
  connection, accounts: watch.tokenAccounts.map((x) => new PublicKey(x)), usdcMint, vaultToken: new PublicKey(watch.vaultToken), vaultProgram: programId,
  intervalMs: 4000, sinceSlot,
  streams: rpcOnly || !apiKey ? null : { apiKey, ...(process.env.STREAMS_WEBHOOK_URL ? { webhookUrl: process.env.STREAMS_WEBHOOK_URL, port: Number(process.env.STREAMS_PORT ?? 8787) } : {}) },
  onObservation: (o) => report(o, watcher.observations),
  onStatus: (state, detail) => { dashboard.emit({ type: "source", state, text: detail }); console.log(dim(`[source] ${detail}`)); },
  onError: (e) => console.error(dim(`RPC error: ${(e as Error).message}`)),
  onDeposit: () => {
    if (!adminToken) return;
    void fetch(`${mintUrl}/v1/blindfold/admin/poll-deposits`, { method: "POST", headers: { authorization: `Bearer ${adminToken}` } }).catch(() => undefined);
  },
});
if (historyMin > 0) await watcher.scan().catch((e) => console.error(dim(`RPC error: ${(e as Error).message}`)));
if (watcher.observations.length === 0) say(dim("nothing yet; waiting for transactions..."));
if (!apiKey && !rpcOnly) {
  const text = "no .keys/quicknode.json; polling RPC every 4 s";
  dashboard.emit({ type: "source", state: "polling", text });
  say(dim(`[source] ${text}`));
}
watcher.start();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => { void watcher.stop().finally(() => dashboard.close().finally(() => process.exit(0))); });
}
