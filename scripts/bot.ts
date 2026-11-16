// Competitor bot, standalone: watches the provider's payout account and the vault using only public Solana RPC,
// and prints what each transaction reveals. Run it in a second terminal next to `pnpm demo`.
//
//   pnpm bot                         devnet, provider payout account from .keys/provider-payout.json
//   pnpm bot --account <token-acct>  watch any USDC token account
//   pnpm bot --once                  print what is visible from the last 25 transactions and exit
//
// Env: SOLANA_RPC_URL (default devnet), VAULT_PROGRAM_ID, USDC_MINT, KEYS_DIR.
import "./lib/quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { DEFAULT_VAULT_PROGRAM_ID, SOLANA_COMMITMENT, USDC_DEVNET_MINT, vaultAta } from "@blindfold/protocol";
import { observe, type Observation } from "./lib/bot.js";
import { explorerTx } from "./lib/explorer.js";
import { act, bold, dim, green, red, say, short, usd } from "./lib/narrate.js";

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

function report(o: Observation) {
  if (o.kind === "direct_payment") {
    console.log(`${time(o)}  ${red(bold("PAYMENT SEEN"))}  wallet ${o.from} paid the provider ${usd(o.amountBase)}`);
    say(dim(`Standard x402: the payer's wallet, amount and time are public. ${explorerTx(o.signature, rpc)}`));
  } else if (o.kind === "vault_payout") {
    console.log(`${time(o)}  ${green(bold("VAULT PAYOUT"))}  Blindfold vault paid the provider ${usd(o.amountBase)} in one batch`);
    say(dim(`No payer visible: this batch covers many calls from unknown agents. ${explorerTx(o.signature, rpc)}`));
  } else {
    console.log(`${time(o)}  ${green(bold("VAULT DEPOSIT"))} ${short(o.from)} deposited ${usd(o.amountBase)} into the Blindfold vault`);
    say(dim(`An owner funding tokens. What they will buy, and from whom, is not visible. ${explorerTx(o.signature, rpc)}`));
  }
}

act("Competitor bot", `Watching public Solana data only. Provider account ${short(account.toBase58())}, vault ${short(vaultToken.toBase58())}.`);
const seen = new Set<string>();
let first = true;
for (;;) {
  const found = [
    ...(await observe({ connection, account, usdcMint, vaultToken, limit: first ? 25 : 10 }).catch(() => [])),
    ...(await observe({ connection, account: vaultToken, usdcMint, vaultToken, limit: first ? 25 : 10 }).catch(() => [])),
  ].sort((a, b) => a.slot - b.slot);
  for (const o of found) {
    if (seen.has(o.signature)) continue;
    seen.add(o.signature);
    report(o);
  }
  if (first && found.length === 0) console.log(dim("nothing yet; waiting for transactions..."));
  first = false;
  if (once) break;
  await new Promise((r) => setTimeout(r, 4000));
}
