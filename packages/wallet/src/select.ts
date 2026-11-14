import { signerSet, type WireProof } from "@blindfold/protocol";

export type SelectError = "insufficient_balance" | "insufficient_exact" | "provider_not_in_signer_set";

const safeSigners = (secret: string): string[] => {
  try {
    return signerSet(secret);
  } catch {
    return [];
  }
};

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** a is better than b: fewer proofs, then lexicographically smaller list of secrets. */
function better(a: WireProof[], b: WireProof[]): boolean {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) {
    const c = cmp(a[i].secret, b[i].secret);
    if (c !== 0) return c < 0;
  }
  return false;
}

/** Deterministic exact-sum subset selection (04-wallet-sdk.md, Exact-sum selection). Pure. */
export function selectExact(
  proofs: WireProof[],
  amount: number,
  providerPubkey: string,
): { chosen: WireProof[] } | { error: SelectError } {
  const pk = providerPubkey.toLowerCase();
  const all = proofs.length;
  const candidates = proofs.filter((p) => safeSigners(p.secret).includes(pk));
  if (all > 0 && candidates.length === 0) return { error: "provider_not_in_signer_set" };
  const usable = candidates.filter((p) => p.amount <= amount);
  if (usable.reduce((s, p) => s + p.amount, 0) < amount) return { error: "insufficient_balance" };
  usable.sort((a, b) => b.amount - a.amount || cmp(a.secret, b.secret));
  const best: (WireProof[] | null)[] = new Array(amount + 1).fill(null);
  best[0] = [];
  for (const p of usable) {
    for (let s = amount; s >= p.amount; s--) {
      const prev = best[s - p.amount];
      if (!prev) continue;
      const cand = [...prev, p];
      const cur = best[s];
      if (!cur || better(cand, cur)) best[s] = cand;
    }
  }
  const hit = best[amount];
  if (!hit || hit.length === 0) return { error: "insufficient_exact" };
  return { chosen: hit };
}
