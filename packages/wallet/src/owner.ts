import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Amount, HttpResponseError, Mint, OutputData, createRandomSecretKey, getPubKeyFromPrivKey, signMintQuote,
  type Proof, type SerializedBlindedMessage, type SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import {
  CASHU_UNIT, DEPOSIT_POLL_MS, MAX_DEPOSIT_CENTS, MAX_MINT_OUTPUTS, buildLockOptions, signerSet, toWireProof,
  type ProviderInfo, type WireProof,
} from "@blindfold/protocol";
import type { Depositor } from "./depositor.js";
import { verifyDleq } from "./dleq.js";
import { planDenominations } from "./denominations.js";
import { atomicWriteJson, FileTokenStore, type StoredFile } from "./store.js";

export type FundStep = "quote" | "deposit" | "wait_paid" | "mint" | "write";

export interface FundOptions {
  mintUrl: string;
  cents: number;
  /** provider_id to price in cents. Overrides the denomination plan only. */
  prices?: Record<number, number>;
  tokenFile: string;
  depositor: Depositor;
  stateDir?: string;
  pollMs?: number;
  timeoutMs?: number;
  mint?: Mint;
  fetch?: typeof fetch;
  onProgress?: (s: FundStep) => void;
}

interface SavedOutput {
  amount: number;
  id: string;
  B_: string;
  secretHex: string;
  rHex: string;
}

/** Resumable state (04-wallet-sdk.md, Owner funding), persisted after every step. Holds the quote key: mode 0600. */
export interface FundState {
  version: 1;
  mintUrl: string;
  cents: number;
  tokenFile: string;
  quoteKey: string;
  quotePubkey: string;
  allowlist: string[];
  plan: number[];
  quote?: string;
  request?: string;
  depositTx?: string;
  keysetId?: string;
  outputs?: SavedOutput[];
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const defaultStateDir = () => join(homedir(), ".blindfold", "owner");
const statePath = (dir: string, pk: string) => join(dir, `${pk}.json`);

export async function fetchProviders(mintUrl: string, f: typeof fetch = fetch): Promise<ProviderInfo[]> {
  const res = await f(`${mintUrl.replace(/\/+$/, "")}/v1/blindfold/providers`);
  if (!res.ok) throw new Error(`providers request failed: HTTP ${res.status}`);
  return (await res.json()) as ProviderInfo[];
}

async function saveState(dir: string, st: FundState): Promise<void> {
  await atomicWriteJson(statePath(dir, st.quotePubkey), st);
}

export async function loadFundState(stateDir: string | undefined, quotePubkey: string): Promise<FundState> {
  const text = await readFile(statePath(stateDir ?? defaultStateDir(), quotePubkey), "utf8");
  return JSON.parse(text) as FundState;
}

export async function ownerFund(o: FundOptions): Promise<{ quote: string; cents: number; proofs: number; depositTx: string }> {
  if (!Number.isSafeInteger(o.cents) || o.cents < 1 || o.cents > MAX_DEPOSIT_CENTS) {
    throw new RangeError(`cents must be an integer in 1..${MAX_DEPOSIT_CENTS}`);
  }
  const stateDir = o.stateDir ?? defaultStateDir();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Step 0: providers and the global allowlist.
  const providers = (await fetchProviders(o.mintUrl, o.fetch)).filter((p) => p.active);
  const allowlist = [...new Set(providers.map((p) => p.pubkey.toLowerCase()))].sort();
  if (allowlist.length === 0) throw new Error("mint lists no active providers; nothing to lock tokens to");
  const prices = o.prices
    ? Object.values(o.prices)
    : providers.map((p) => p.price_cents).filter((x): x is number => typeof x === "number");
  const fallback = Number(process.env.PRICE_CENTS ?? 5);
  const plan = planDenominations(o.cents, prices.length ? prices : [fallback]);

  // Step 1: quote key, persisted before the quote request.
  const sk = createRandomSecretKey();
  const st: FundState = {
    version: 1, mintUrl: o.mintUrl, cents: o.cents, tokenFile: o.tokenFile,
    quoteKey: hex(sk), quotePubkey: hex(getPubKeyFromPrivKey(sk)), allowlist, plan,
  };
  await saveState(stateDir, st);
  return runFund(st, o, stateDir);
}

/** Resume a saved FundState (crash after any step). Never deposits twice. */
export async function ownerResume(
  quotePubkey: string,
  o: Pick<FundOptions, "depositor" | "stateDir" | "pollMs" | "timeoutMs" | "mint" | "fetch" | "onProgress">,
): Promise<{ quote: string; cents: number; proofs: number; depositTx: string }> {
  const stateDir = o.stateDir ?? defaultStateDir();
  const st = await loadFundState(stateDir, quotePubkey);
  return runFund(st, { ...o, mintUrl: st.mintUrl, cents: st.cents, tokenFile: st.tokenFile }, stateDir);
}

async function runFund(st: FundState, o: FundOptions, stateDir: string) {
  const mint = o.mint ?? new Mint(st.mintUrl);
  const progress = o.onProgress ?? (() => undefined);
  const pollMs = o.pollMs ?? DEPOSIT_POLL_MS;
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);

  // Step 2: quote.
  progress("quote");
  if (!st.quote) {
    const q = await mint.createMintQuote("solana-usdc", { unit: CASHU_UNIT, amount: st.cents, pubkey: st.quotePubkey });
    if (q.pubkey !== st.quotePubkey) throw new Error("mint returned a quote for a different pubkey");
    if (!q.request || !/^[0-9a-f]{64}$/.test(q.request)) throw new Error("mint returned a bad deposit_ref");
    const qa = (q as { amount?: unknown }).amount;
    if (qa !== undefined && Amount.from(qa as number).toNumber() !== st.cents) throw new Error("mint returned a quote for a different amount");
    st.quote = q.quote;
    st.request = q.request;
    await saveState(stateDir, st);
  }

  // Step 3: deposit (skipped on resume if already sent).
  progress("deposit");
  if (!st.depositTx) {
    const { signature } = await o.depositor.deposit({ amountCents: st.cents, depositRef: unhex(st.request!) });
    st.depositTx = signature;
    await saveState(stateDir, st);
  }

  // Step 4: wait for the mint to see the deposit (not needed once outputs exist: the mint may have issued already).
  progress("wait_paid");
  if (!st.outputs) {
    for (;;) {
      const q = await mint.checkMintQuote("solana-usdc", st.quote);
      const paid = q.amount_paid ? Amount.from(q.amount_paid).toNumber() : 0;
      const issued = q.amount_issued ? Amount.from(q.amount_issued).toNumber() : 0;
      if (paid - issued >= st.cents) break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the deposit to be detected");
      await sleep(pollMs);
    }
  }

  // Step 5: keyset and outputs.
  const { keysets } = await mint.getKeySets();
  const active = st.keysetId
    ? keysets.find((k) => k.id === st.keysetId)
    : keysets.find((k) => k.active && k.unit === CASHU_UNIT);
  if (!active) throw new Error("no active usd keyset");
  const { keysets: keyList } = await mint.getKeys(active.id);
  const keyset = keyList.find((k) => k.id === active.id);
  if (!keyset) throw new Error("mint did not return the keys of its keyset");
  if (!st.outputs) {
    const data = OutputData.createP2PKData(buildLockOptions(st.allowlist), st.cents, keyset, st.plan);
    st.keysetId = active.id;
    st.outputs = data.map((d) => ({
      amount: Amount.from(d.blindedMessage.amount).toNumber(), id: d.blindedMessage.id, B_: d.blindedMessage.B_,
      secretHex: hex(d.secret), rHex: d.blindingFactor.toString(16),
    }));
    await saveState(stateDir, st);
  }
  const outputs = st.outputs.map((s) =>
    new OutputData(
      { amount: Amount.from(s.amount), id: s.id, B_: s.B_ } as SerializedBlindedMessage,
      BigInt(`0x${s.rHex}`), unhex(s.secretHex),
    ));

  // Step 6: sign and mint, chunked. A resend of identical outputs returns the stored signatures (00 section 5.4).
  progress("mint");
  const signatures: SerializedBlindedSignature[] = [];
  for (let i = 0; i < outputs.length; i += MAX_MINT_OUTPUTS) {
    const blinded = outputs.slice(i, i + MAX_MINT_OUTPUTS).map((d) => d.blindedMessage);
    const signature = signMintQuote(st.quoteKey, st.quote, blinded);
    signatures.push(...(await mintWithResend(mint, { quote: st.quote, outputs: blinded, signature })));
  }
  if (signatures.length !== outputs.length) throw new Error("mint returned the wrong number of signatures");

  // Step 7: unblind, verify DLEQ, check sum and lock.
  const proofs: Proof[] = outputs.map((d, i) => d.toProof(signatures[i], keyset));
  const dleq = await verifyDleq(proofs, keyset);
  if (!dleq.ok) throw new Error(`mint returned ${dleq.invalid} invalid DLEQ proof(s); token file not written`);
  const total = proofs.reduce((s, p) => s + Amount.from(p.amount).toNumber(), 0);
  if (total !== st.cents) throw new Error(`issued ${total} cents, expected ${st.cents}`);
  const want = [...st.allowlist].sort().join();
  for (const p of proofs) {
    if ([...signerSet(p.secret)].sort().join() !== want) throw new Error("issued proof lock does not match the allowlist");
  }

  // Step 8: write (append on top-up).
  progress("write");
  const store = new FileTokenStore(st.tokenFile);
  const wire = proofs.map((p) => toWireProof(p));
  let file: StoredFile;
  if (existsSync(st.tokenFile)) {
    file = await store.read();
    if (file.mint.replace(/\/+$/, "") !== st.mintUrl.replace(/\/+$/, "")) throw new Error("token file is for a different mint");
    file.proofs.push(...wire);
  } else {
    file = { version: 1, mint: st.mintUrl, unit: "usd", proofs: wire };
  }
  await store.write(file);
  await unlink(statePath(stateDir, st.quotePubkey)).catch(() => undefined);
  return { quote: st.quote, cents: st.cents, proofs: wire.length, depositTx: st.depositTx };
}

async function mintWithResend(
  mint: Mint,
  req: { quote: string; outputs: SerializedBlindedMessage[]; signature: string },
): Promise<SerializedBlindedSignature[]> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (await mint.mint("solana-usdc", req)).signatures;
    } catch (e) {
      // A definite mint answer (4xx) is final. Network errors and 5xx mean the response may be lost: resend identically.
      if (e instanceof HttpResponseError && e.status < 500) throw e;
      last = e;
    }
  }
  throw last;
}

export async function ownerBalance(tokenFile: string): Promise<{ spendable: number; pending: number; byDenom: Record<number, number> }> {
  const f = await new FileTokenStore(tokenFile).read();
  const byDenom: Record<number, number> = {};
  for (const p of f.proofs) byDenom[p.amount] = (byDenom[p.amount] ?? 0) + 1;
  const sum = (ps: WireProof[]) => ps.reduce((s, p) => s + p.amount, 0);
  return { spendable: sum(f.proofs), pending: (f.pending ?? []).reduce((s, e) => s + sum(e.proofs), 0), byDenom };
}

