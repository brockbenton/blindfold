import { KEYSET_AMOUNTS } from "@blindfold/protocol";

const MAX_DENOM = KEYSET_AMOUNTS[KEYSET_AMOUNTS.length - 1];

/** Binary decomposition, largest first, capped at the largest keyset amount. */
function binary(n: number): number[] {
  const out: number[] = [];
  let r = n;
  while (r > 0) {
    let p = MAX_DENOM;
    while (p > r) p /= 2;
    out.push(p);
    r -= p;
  }
  return out;
}

/**
 * Denomination plan (04 section 5.5): 80% of the funds as exact bundles per expected price
 * (binary decomposition of the price), the rest as a unary-pair ladder 1,1,2,2,4,4... then binary.
 */
export function planDenominations(cents: number, prices: number[]): number[] {
  if (!Number.isSafeInteger(cents) || cents < 1) throw new RangeError("cents must be a positive integer");
  let ps = [...new Set(prices.filter((p) => Number.isSafeInteger(p) && p >= 1 && p <= cents))];
  if (ps.length === 0) ps = [Math.min(5, cents)];
  const share = Math.floor((cents * 0.8) / ps.length);
  const out: number[] = [];
  let spent = 0;
  for (const p of ps) {
    const n = Math.floor(share / p);
    for (let i = 0; i < n; i++) out.push(...binary(p));
    spent += n * p;
  }
  let rest = cents - spent;
  const ladder: number[] = [];
  ladder: for (let p = 1; p <= MAX_DENOM; p *= 2) {
    for (let k = 0; k < 2; k++) {
      if (rest < p) break ladder;
      ladder.push(p);
      rest -= p;
    }
  }
  out.push(...ladder, ...binary(rest));
  const total = out.reduce((a, b) => a + b, 0);
  if (total !== cents || !out.every((d) => KEYSET_AMOUNTS.includes(d))) throw new Error("denomination plan is invalid");
  return out;
}
