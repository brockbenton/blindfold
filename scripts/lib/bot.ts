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

/**
 * Observes USDC arriving at `account` (a token account) since `sinceSlot`. Transfers from `vaultToken` are payouts;
 * transfers into `vaultToken` are deposits; anything else is a direct payment.
 */
export async function observe(o: {
  connection: Connection; account: PublicKey; usdcMint: PublicKey; vaultToken: PublicKey; sinceSlot?: number; limit?: number;
}): Promise<Observation[]> {
  const sigs = await retry(() => o.connection.getSignaturesForAddress(o.account, { limit: o.limit ?? 50 }, SOLANA_COMMITMENT));
  const out: Observation[] = [];
  for (const s of sigs) {
    if (s.err || (o.sinceSlot !== undefined && s.slot < o.sinceSlot)) continue;
    // @x402/svm sends version 1 transactions; web3.js 1.x types only name version 0.
    const tx = await retry(() => o.connection.getParsedTransaction(s.signature, { commitment: SOLANA_COMMITMENT, maxSupportedTransactionVersion: 1 as 0 }));
    if (!tx) continue;
    const m = movements(tx, o.account, o.usdcMint.toBase58());
    if (!m) continue;
    const kind: ObservationKind = o.account.equals(o.vaultToken)
      ? "vault_deposit"
      : m.fromAccount === o.vaultToken.toBase58() ? "vault_payout" : "direct_payment";
    out.push({ kind, signature: s.signature, slot: s.slot, time: s.blockTime ? new Date(s.blockTime * 1000) : null, from: m.from, to: m.to, amountBase: m.amount });
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
