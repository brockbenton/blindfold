import { randomBytes } from "node:crypto";
import {
  Amount, OutputData, createRandomSecretKey, getPubKeyFromPrivKey, signMintQuote, signP2PKProofs, type Proof, type P2PKOptions,
} from "@cashu/cashu-ts";
import { PLACEHOLDER_VAULT_PROGRAM_ID, USDC_DEVNET_MINT, buildLockOptions, toWireProof } from "@blindfold/protocol";
import pg from "pg";
import { FakeSender, MemoryVault } from "../src/chain/memory.js";
import type { AppConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { createMint } from "../src/mint.js";

export const ADMIN = "test-admin-token";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// Defaults to the cluster from scripts/dev-pg.sh.
const DATABASE_URL = process.env.DATABASE_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:54329/blindfold`;

export type Harness = Awaited<ReturnType<typeof setupMint>>;

/** A mint on a fresh Postgres schema with an in-memory vault and fake sender. */
export async function setupMint(o: { seedByte?: number; providersFile?: AppConfig["providers"]; cfg?: Partial<AppConfig> } = {}) {
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`create schema ${schema}`);
  const db = createPool(DATABASE_URL, schema);
  const vault = new MemoryVault();
  const sender = new FakeSender(vault);
  const cfg: AppConfig = {
    SOLANA_RPC_URL: "http://127.0.0.1:8899", VAULT_PROGRAM_ID: PLACEHOLDER_VAULT_PROGRAM_ID, USDC_MINT: USDC_DEVNET_MINT,
    MINT_URL: "http://localhost:3338", DATABASE_URL, MINT_SEED: (o.seedByte ?? 7).toString(16).padStart(2, "0").repeat(32),
    MINT_AUTHORITY_KEYPAIR: "", MINT_ADMIN_TOKEN: ADMIN, PORT: 0,
    providers: o.providersFile ?? [{ provider_id: 0, name: "mock-api", url: "http://localhost:4000", price_cents: 5, topics: ["sol", "btc"] }],
    depositPollMs: 1e9, settleIntervalS: 1e9, devFakeChain: false,
    ...o.cfg,
  };
  const mint = await createMint({ db, cfg, vault, sender, confirmTimeoutMs: 50 });
  const { app, ctx } = mint;

  async function req(path: string, init: { method?: string; body?: unknown; auth?: boolean | string; raw?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.auth) headers.authorization = `Bearer ${init.auth === true ? ADMIN : init.auth}`;
    const res = await app.request(path, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  }

  const keyset = async () => {
    const r = await req("/v1/keys");
    return r.json.keysets[0] as { id: string; keys: Record<string, string> };
  };
  const cleanup = async () => {
    await db.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  };
  return { app, ctx, db, vault, sender, cfg, req, keyset, cleanup, schema };
}

export function newKey() {
  const sk = createRandomSecretKey();
  return { sk: hex(sk), pubkey: hex(getPubKeyFromPrivKey(sk)) };
}

/** Register a provider onchain (in memory) and sync it into the mint. */
export async function addProvider(h: Harness) {
  const k = newKey();
  const rec = h.vault.addProvider({ cashuPubkey: k.pubkey });
  await h.ctx.tick();
  return { ...k, id: rec.providerId };
}

export async function newQuote(h: Harness, amount: number) {
  const k = newKey();
  const r = await h.req("/v1/mint/quote/solana-usdc", { body: { unit: "usd", amount, pubkey: k.pubkey } });
  if (r.status !== 200) throw new Error(`quote failed: ${JSON.stringify(r.json)}`);
  return { ...(r.json as { quote: string; request: string; amount: number; pubkey: string }), sk: k.sk };
}

export async function fund(h: Harness, q: { request: string }, cents: number) {
  h.vault.addDeposit({ amountBase: BigInt(cents) * 10_000n, depositRef: q.request });
  await h.ctx.tick();
}

export interface Built { ods: OutputData[]; body: (q: { quote: string; sk: string }) => object }

/** Locked outputs for `amounts`, plus the request body with a NUT-20 signature. */
export async function buildMint(h: Harness, lock: P2PKOptions | string[] | "random", amounts: number[]): Promise<Built> {
  const ks = await keyset();
  const total = amounts.reduce((a, b) => a + b, 0);
  const ods = lock === "random"
    ? OutputData.createRandomData(total, ks, amounts)
    : OutputData.createP2PKData(Array.isArray(lock) ? buildLockOptions(lock) : lock, total, ks, amounts);
  return {
    ods,
    body: (q) => {
      const outputs = ods.map((od) => ({ amount: Number(od.blindedMessage.amount.toString()), id: od.blindedMessage.id, B_: od.blindedMessage.B_ }));
      return { quote: q.quote, outputs, signature: signMintQuote(q.sk, q.quote, ods.map((od) => od.blindedMessage)) };
    },
  };
  async function keyset() { return h.keyset(); }
}

export function unblind(ods: OutputData[], sigs: any[], ks: { id: string; keys: Record<string, string> }): Proof[] {
  return ods.map((od, i) => od.toProof({ id: sigs[i].id, amount: Amount.from(sigs[i].amount), C_: sigs[i].C_, dleq: sigs[i].dleq } as never, ks as never));
}

/** Quote, deposit, mint locked proofs. Returns the proofs. */
export async function issue(h: Harness, lock: P2PKOptions | string[] | "random", amounts: number[]) {
  const total = amounts.reduce((a, b) => a + b, 0);
  const q = await newQuote(h, total);
  await fund(h, q, total);
  const b = await buildMint(h, lock, amounts);
  const r = await h.req("/v1/mint/solana-usdc", { body: b.body(q) });
  if (r.status !== 200) throw new Error(`mint failed: ${JSON.stringify(r.json)}`);
  return unblind(b.ods, r.json.signatures, await h.keyset());
}

export const redeemBody = (proofs: Proof[]) => ({ proofs: proofs.map(toWireProof) });
export const redeem = (h: Harness, proofs: Proof[]) => h.req("/v1/blindfold/redeem", { body: redeemBody(proofs) });
export const sign = (proofs: Proof[], sk: string) => signP2PKProofs(proofs, sk);
export const balances = async (h: Harness) => Object.fromEntries((await h.req("/v1/blindfold/admin/balances", { auth: true })).json.map((r: any) => [r.provider_id, r.balance]));
