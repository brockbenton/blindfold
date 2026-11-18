// Creates (or updates) the observer's QuickNode Stream from code: network solana-devnet, dataset block, the filter in
// scripts/streams/observer-filter.js with the feed and vault addresses filled in, webhook destination. The Stream is
// left paused with a placeholder URL; `pnpm bot` and `pnpm demo` point it at their own tunnel and activate it.
//
//   pnpm streams:setup                 create or update the Stream (paused)
//   pnpm streams:setup --test <slot>   also run the filter on one devnet block through QuickNode's test_filter
//   pnpm streams:setup --local <file>  run the filter locally on a saved block payload (JSON array of blocks)
//   pnpm streams:setup --status        show the Stream and exit
//   pnpm streams:setup --delete        delete the Stream
//
// Needs .keys/quicknode.json ({ "apiKey": "..." }, a QuickNode API key with Streams access) or QUICKNODE_API_KEY.
// Env: VAULT_PROGRAM_ID, USDC_MINT, KEYS_DIR. --account <token account> watches another feed account.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { DEFAULT_VAULT_PROGRAM_ID, USDC_DEVNET_MINT } from "@blindfold/protocol";
import {
  STREAM_NAME, StreamsApi, defaultWatch, filterSource, loadApiKey, newSecurityToken, runFilter, streamSpec,
} from "./lib/streams.js";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const keys = process.env.KEYS_DIR ?? fileURLToPath(new URL("../.keys", import.meta.url));
const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? DEFAULT_VAULT_PROGRAM_ID);
const usdcMint = new PublicKey(process.env.USDC_MINT ?? USDC_DEVNET_MINT);
const account = flag("--account");
const watch = defaultWatch({ keysDir: keys, usdcMint, programId, ...(account ? { account: new PublicKey(account) } : {}) });
const show = (o: unknown) => console.log(JSON.stringify(o, null, 2));

const local = flag("--local");
if (local) {
  show(runFilter(watch, { data: JSON.parse(readFileSync(local, "utf8")) }));
  process.exit(0);
}

const apiKey = loadApiKey(keys);
if (!apiKey) throw new Error(`no QuickNode API key: write {"apiKey": "..."} to ${keys}/quicknode.json or set QUICKNODE_API_KEY`);
const api = new StreamsApi(apiKey);
const existing = await api.find();

if (argv.includes("--delete")) {
  if (existing) await api.remove(existing.id);
  console.log(existing ? `deleted ${STREAM_NAME} (${existing.id})` : `no Stream named ${STREAM_NAME}`);
  process.exit(0);
}

const summary = (s: { id: string; status: string }) => ({
  name: STREAM_NAME, id: s.id, status: s.status, network: "solana-devnet", dataset: "block", watch,
  filter: { file: "scripts/streams/observer-filter.js", sha256: createHash("sha256").update(filterSource(watch)).digest("hex").slice(0, 16) },
});

if (argv.includes("--status")) {
  if (!existing) console.log(`no Stream named ${STREAM_NAME}; run pnpm streams:setup`);
  else show({ ...summary(existing), webhook: (await api.get(existing.id)).destination_attributes?.url });
  process.exit(0);
}

const spec = streamSpec(watch, { url: "https://example.com/blindfold-observer", token: newSecurityToken(), status: "paused" });
let stream;
if (existing) {
  await api.update(existing.id, { filter_function: spec.filter_function });
  stream = await api.get(existing.id);
  console.log(`updated the filter of ${STREAM_NAME}`);
} else {
  stream = await api.create(spec);
  console.log(`created ${STREAM_NAME}`);
}
show(summary(stream));

const slot = flag("--test");
if (slot) {
  console.log(`\ntest_filter on solana-devnet block ${slot}:`);
  show((await api.testFilter(watch, Number(slot))).result);
}
