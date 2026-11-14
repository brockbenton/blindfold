import { hashToCurve } from "@cashu/cashu-ts";
import type { WireProof } from "@blindfold/protocol";

export interface MintLike {
  check(p: { Ys: string[] }): Promise<{ states: { Y: string; state: "UNSPENT" | "SPENT" | "PENDING" }[] }>;
}

/** Y = hash_to_curve(secret), compressed hex (00 section 3.1). */
export function proofY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

export interface Classified {
  unspent: WireProof[];
  spent: WireProof[];
  pending: WireProof[];
}

/** NUT-07 checkstate. Throws if the mint cannot be reached; callers then keep the proofs pending. */
export async function classify(mint: MintLike, proofs: WireProof[]): Promise<Classified> {
  const out: Classified = { unspent: [], spent: [], pending: [] };
  if (proofs.length === 0) return out;
  const Ys = proofs.map((p) => proofY(p.secret));
  const res = await mint.check({ Ys });
  const byY = new Map(res.states.map((s) => [s.Y.toLowerCase(), s.state]));
  proofs.forEach((p, i) => {
    const st = byY.get(Ys[i]);
    if (st === "UNSPENT") out.unspent.push(p);
    else if (st === "SPENT") out.spent.push(p);
    else out.pending.push(p); // PENDING or missing: unknown, never returned blindly
  });
  return out;
}
