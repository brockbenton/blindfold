// Copycat, standalone: a front-running bot that watches a data provider's USDC account and the Blindfold vault
// using only public Solana RPC, prints what each transaction reveals and the trading signal it infers. Run it in a
// second terminal next to `pnpm demo`.
//
//   pnpm bot                         devnet, provider payout account from .keys/provider-payout.json
//   pnpm bot --account <token-acct>  watch any USDC token account
//   pnpm bot --once                  print what is visible from the last 20 transactions and exit
//
// Env: SOLANA_RPC_URL (default devnet), VAULT_PROGRAM_ID, USDC_MINT, KEYS_DIR.
import "./lib/quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT, vaultAta } from "@blindfold/protocol";
import type { Observation } from "./lib/bot.js";
import { ChainWatcher, attributeVault, describe, infer } from "./lib/copycat.js";
import { explorerTx } from "./lib/explorer.js";
import { act, bold, dim, green, magenta, red, say, short } from "./lib/narrate.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const once = argv.includes("--once");
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
const keys = process.env.KEYS_DIR ?? fileURLToPath(new URL("../.keys", import.meta.url));

function providerAccount(): PublicKey {
  const a = flag("--account");
  if (a) return new PublicKey(a);
  const p = join(keys, "provider-payout.json");
  if (!existsSync(p)) throw new Error(`pass --account <token account>, or restore ${p}`);
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[])).publicKey;
  return getAssociatedTokenAddressSync(usdcMint, owner);
}

const connection = new Connection(rpc, SOLANA_COMMITMENT);
const account = providerAccount();
const vaultToken = vaultAta(usdcMint, programId);
const time = (o: Observation) => (o.time ? o.time.toISOString().slice(11, 19) : "--:--:--");

const signals = new Map<string, string>();

function report(o: Observation, all: Observation[]) {
  const label = o.kind === "direct_payment" ? red(bold("PAYMENT     ")) : o.kind === "vault_payout" ? green(bold("VAULT PAYOUT")) : green(bold("VAULT DEPOSIT"));
  console.log(`${time(o)}  ${label}  ${describe(o)}`);
  say(dim(explorerTx(o.signature, rpc)));
  if (o.kind !== "direct_payment") {
    const r = attributeVault(all);
    const tone = r.action === "NO SIGNAL" || r.action === "CANNOT ATTRIBUTE" ? green : red;
    console.log(`          ${bold(magenta("Copycat"))}  ${tone(bold(r.action))}  ${dim(r.reason)}`);
    return;
  }
  const s = infer(all).find((x) => x.payer === o.from);
  if (!s || signals.get(s.payer) === s.reason) return;
  signals.set(s.payer, s.reason);
  console.log(`          ${bold(magenta("Copycat"))}  ${red(bold(s.action))}  ${s.reason}`);
}

act("Copycat", `A front-running bot reading public Solana data only. Feed account ${short(account.toBase58())}, vault ${short(vaultToken.toBase58())}.`);
// Starts from recent history (the last 20 transactions per account), then reports new ones as they land.
const watcher = new ChainWatcher({
  connection, accounts: [account, vaultToken], usdcMint, vaultToken, intervalMs: 4000,
  onObservation: (o) => report(o, watcher.observations),
});
await watcher.scan().catch((e) => console.error(dim(`RPC error: ${(e as Error).message}`)));
if (watcher.observations.length === 0) console.log(dim("nothing yet; waiting for transactions..."));
if (once) process.exit(0);
watcher.start();
