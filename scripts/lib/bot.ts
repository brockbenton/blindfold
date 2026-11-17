// Competitor bot: a public-chain observer. It reads only what anyone can read from Solana RPC (token account
// history), with no access to the mint, provider logs or wallets, and reports what it can infer.
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { SOLANA_COMMITMENT } from "@blindfold/protocol";

export type ObservationKind =
  /** USDC sent straight from a wallet to the provider: a standard x402 `exact` payment, payer visible. */
  | "direct_payment"
  /** USDC sent from the Blindfold vault to the provider: a settlement batch, no payer visible. */
  | "vault_payout"
  /** USDC sent from a wallet into the Blindfold vault: an owner deposit. */
  | "vault_deposit";

export interface Observation {
  kind: ObservationKind;
  signature: string;
  slot: number;
  time: Date | null;
  /** Wallet that sent the USDC (the vault's own token account for payouts). */
  from: string;
  to: string;
  amountBase: bigint;
  /** Text of a memo instruction in the same transaction (x402 `exact` adds one per payment). */
  memo?: string;
  /** Where Copycat read it: a QuickNode Stream delivery or an RPC poll. */
  via?: "streams" | "rpc";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

/** USDC movements into `watched` in one transaction, using balance deltas (works for any instruction layout). */
function movements(tx: ParsedTransactionWithMeta, watched: PublicKey, mint: string): { from: string; fromAccount: string; to: string; amount: bigint } | null {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const pre = new Map((tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => [b.accountIndex, b]));
  const post = (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const delta = (i: number) => BigInt(post.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0") - BigInt(pre.get(i)?.uiTokenAmount.amount ?? "0");
  const wi = keys.indexOf(watched.toBase58());
  if (wi < 0) return null;
  const received = delta(wi);
  if (received <= 0n) return null;
  const indexes = new Set([...pre.keys(), ...post.map((b) => b.accountIndex)]);
  const senderIndex = [...indexes].find((i) => i !== wi && delta(i) < 0n);
  if (senderIndex === undefined) return null;
  const owner = pre.get(senderIndex)?.owner ?? post.find((b) => b.accountIndex === senderIndex)?.owner ?? keys[senderIndex];
  const toOwner = post.find((b) => b.accountIndex === wi)?.owner ?? keys[wi];
  return { from: owner, fromAccount: keys[senderIndex], to: toOwner, amount: received };
}

/** The first SPL Memo in a parsed transaction, if any. */
export function memoOf(tx: ParsedTransactionWithMeta): string | undefined {
  for (const ix of tx.transaction.message.instructions) {
    if ("parsed" in ix && ix.program === "spl-memo" && typeof ix.parsed === "string") return ix.parsed;
  }
  return undefined;
}

/** What one transaction shows about USDC arriving at `account`, or null when it shows nothing. */
export function toObservation(
  tx: ParsedTransactionWithMeta, s: { signature: string; slot: number; blockTime?: number | null },
  account: PublicKey, usdcMint: PublicKey, vaultToken: PublicKey,
): Observation | null {
  const m = movements(tx, account, usdcMint.toBase58());
  if (!m) return null;
  const kind: ObservationKind = account.equals(vaultToken)
    ? "vault_deposit"
    : m.fromAccount === vaultToken.toBase58() ? "vault_payout" : "direct_payment";
  const memo = memoOf(tx);
  return {
    kind, signature: s.signature, slot: s.slot, time: s.blockTime ? new Date(s.blockTime * 1000) : null, from: m.from, to: m.to, amountBase: m.amount,
    ...(memo !== undefined ? { memo } : {}),
  };
}

/** Parsed transaction by signature; @x402/svm sends version 1 transactions, which web3.js 1.x types only name version 0. */
export const getParsed = (connection: Connection, signature: string) =>
  retry(() => connection.getParsedTransaction(signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: 1 as 0 }));
export const getSignatures = (connection: Connection, account: PublicKey, limit: number) =>
  retry(() => connection.getSignaturesForAddress(account, { limit }, SOLANA_COMMITMENT));

/**
 * Observes USDC arriving at `account` (a token account) since `sinceSlot`. Transfers from `vaultToken` are payouts;
 * transfers into `vaultToken` are deposits; anything else is a direct payment.
 */
export async function observe(o: {
  connection: Connection; account: PublicKey; usdcMint: PublicKey; vaultToken: PublicKey; sinceSlot?: number; limit?: number;
}): Promise<Observation[]> {
  const sigs = await getSignatures(o.connection, o.account, o.limit ?? 50);
  const out: Observation[] = [];
  for (const s of sigs) {
    if (s.err || (o.sinceSlot !== undefined && s.slot < o.sinceSlot)) continue;
    const tx = await getParsed(o.connection, s.signature);
    const ob = tx && toObservation(tx, s, o.account, o.usdcMint, o.vaultToken);
    if (ob) out.push(ob);
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** Polls `observe` until `want(observations)` holds (RPC history lags confirmation by a few seconds). */
export async function observeUntil(
  o: Parameters<typeof observe>[0], want: (obs: Observation[]) => boolean, timeoutMs = 60_000,
): Promise<Observation[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const obs = await observe(o);
    if (want(obs) || Date.now() > deadline) return obs;
    await sleep(2000);
  }
}

export interface PayerProfile {
  payer: string;
  calls: number;
  totalBase: bigint;
  times: Date[];
}

/** Groups direct payments by payer: what the bot learns about each agent. */
export function profiles(obs: Observation[]): PayerProfile[] {
  const by = new Map<string, PayerProfile>();
  for (const x of obs.filter((o) => o.kind === "direct_payment")) {
    const p = by.get(x.from) ?? { payer: x.from, calls: 0, totalBase: 0n, times: [] };
    p.calls++;
    p.totalBase += x.amountBase;
    if (x.time) p.times.push(x.time);
    by.set(x.from, p);
  }
  return [...by.values()];
}
