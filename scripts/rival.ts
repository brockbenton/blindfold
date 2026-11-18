// The rival: a standard x402 agent researching one token, for the live MCP demo (docs/DEMO.md, "Live demo with Claude
// and MCP"). It pays TokenFeed's `exact` route from its own Solana wallet every few seconds, so each purchase is a
// public USDC transfer with the seller's memo (`whale-flow/SOL`), and `pnpm watch` shows Copycat reading it.
// Run it next to `pnpm serve --local`, which serves TokenFeed with the exact baseline.
//
//   pnpm rival                       buy SOL whale flow every 20 s until Ctrl-C
//   pnpm rival --topic btc --every 30 --calls 6
//   pnpm rival --feed http://localhost:4000
//
// Wallet: .keys/exact-agent.json (needs devnet USDC; the facilitator pays fees). Env: SOLANA_RPC_URL, USDC_MINT, KEYS_DIR.
import "./lib/quiet.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SOLANA_COMMITMENT, USDC_DEVNET_MINT } from "@blindfold/protocol";
import { exactPayFetch, paymentResponse } from "./lib/exactClient.js";
import { explorerTx } from "./lib/explorer.js";
import { act, bold, dim, ok, red, say, usd, warn } from "./lib/narrate.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const int = (name: string, dflt: number, min: number) => {
  const v = flag(name);
  const n = v === undefined ? dflt : Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}`);
  return n;
};
const topic = (flag("--topic") ?? "sol").toLowerCase();
if (!/^[a-z0-9]{1,16}$/.test(topic)) throw new Error("--topic must be 1-16 lowercase letters or digits");
const everyS = int("--every", 20, 3);
const calls = int("--calls", 0, 0); // 0: until Ctrl-C
const feedUrl = (flag("--feed") ?? "http://localhost:4000").replace(/\/+$/, "");
const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const usdcMint = process.env.USDC_MINT ?? USDC_DEVNET_MINT;
const keys = process.env.KEYS_DIR ?? fileURLToPath(new URL("../.keys", import.meta.url));

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keys, "exact-agent.json"), "utf8")) as number[]));
const connection = new Connection(rpc, SOLANA_COMMITMENT);
const ata = getAssociatedTokenAddressSync(new PublicKey(usdcMint), keypair.publicKey);
const balance = async () => BigInt((await connection.getTokenAccountBalance(ata, SOLANA_COMMITMENT).catch(() => null))?.value.amount ?? "0");

const payer = await exactPayFetch({ keypair: keypair.secretKey, rpcUrl: rpc, usdcMint });
const url = `${feedUrl}/v1/data/${topic}`;
act("Rival agent", `A standard x402 agent researching ${topic.toUpperCase()}. It pays ${url} with \`exact\` from wallet ${payer.address}: every call is a public USDC transfer.`);
const start = await balance();
say(dim(`wallet USDC: ${usd(start)}`));
if (start < 50_000n) warn(`the rival wallet has ${usd(start)}; each call costs about $0.05. Send it devnet USDC: ${payer.address}`);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopping = true; });
/** Waits `ms`, or less if Ctrl-C arrives. */
async function sleep(ms: number) {
  for (const end = Date.now() + ms; !stopping && Date.now() < end;) await new Promise((r) => setTimeout(r, 200));
}

let n = 0;
let failures = 0;
while (!stopping && (calls === 0 || n < calls)) {
  const t = new Date().toISOString().slice(11, 19);
  try {
    const res = await payer.fetch(url);
    const pr = paymentResponse(res);
    if (res.status === 200 && pr?.transaction) {
      n++;
      failures = 0;
      ok(`${t}  bought ${topic.toUpperCase()} whale flow (#${n}), paid onchain`);
      say(dim(explorerTx(pr.transaction, rpc)));
    } else {
      failures++;
      console.log(`${t}  ${red(bold("failed"))} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
  } catch (e) {
    failures++;
    console.log(`${t}  ${red(bold("failed"))} ${(e as Error).message.slice(0, 160)}`);
  }
  if (failures >= 5) { warn("5 failures in a row; stopping. Is `pnpm serve` running with the exact baseline?"); break; }
  if (!stopping && (calls === 0 || n < calls)) await sleep(everyS * 1000);
}
say(dim(`${n} public purchases; wallet USDC now ${usd(await balance())}`));
process.exit(0);
