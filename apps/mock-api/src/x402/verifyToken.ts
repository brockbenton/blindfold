import { getDecodedToken, type Proof } from "@cashu/cashu-ts";
import { BASE_UNITS_PER_CENT, SettleErrorReason as R, validateBlindfoldLock } from "@blindfold/protocol";

export const MAX_TOKEN_CHARS = 64 * 1024;
const MAX_PROOFS = 64;

export type VerifyResult = { ok: true; proofs: Proof[] } | { ok: false; reason: string };

export interface VerifyInput {
  token: unknown;
  mintUrl: string;
  providerPubkey: string;
  /** requirements.amount, USDC base units. Comes from the route config, never from the client. */
  amount: string;
  /** Throws if the keyset list cannot be fetched. */
  keysetIds: (opts?: { refresh?: boolean }) => Promise<string[]>;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** Pure validation of 03-mock-api.md, Token validation, in order. `mint_unavailable` if the keysets cannot be fetched. */
export async function verifyToken(i: VerifyInput): Promise<VerifyResult> {
  const fail = (reason: string): VerifyResult => ({ ok: false, reason });
  const t = i.token;
  if (typeof t !== "string" || !t.startsWith("cashuB") || t.length > MAX_TOKEN_CHARS) return fail(R.MALFORMED_TOKEN);

  let token;
  try {
    let ids: string[];
    try {
      ids = await i.keysetIds();
    } catch {
      return fail(R.MINT_UNAVAILABLE);
    }
    try {
      token = getDecodedToken(t, ids);
    } catch {
      // Unknown keyset id: refetch once.
      try {
        ids = await i.keysetIds({ refresh: true });
      } catch {
        return fail(R.MINT_UNAVAILABLE);
      }
      token = getDecodedToken(t, ids);
    }
  } catch {
    return fail(R.MALFORMED_TOKEN);
  }

  if (trimSlash(token.mint) !== trimSlash(i.mintUrl)) return fail(R.WRONG_MINT);
  if (token.unit !== "usd") return fail(R.WRONG_UNIT);
  const proofs = token.proofs;
  if (proofs.length < 1 || proofs.length > MAX_PROOFS) return fail(R.MALFORMED_TOKEN);
  if (new Set(proofs.map((p) => p.secret)).size !== proofs.length) return fail(R.MALFORMED_TOKEN);

  let want: bigint;
  try {
    const a = BigInt(i.amount);
    if (a <= 0n || a % BASE_UNITS_PER_CENT !== 0n) return fail(R.WRONG_AMOUNT);
    want = a / BASE_UNITS_PER_CENT;
  } catch {
    return fail(R.WRONG_AMOUNT);
  }
  let sum = 0n;
  for (const p of proofs) sum += BigInt(p.amount.toNumber());
  if (sum !== want) return fail(R.WRONG_AMOUNT);

  if (proofs.some((p) => p.witness !== undefined && p.witness !== null)) return fail(R.UNEXPECTED_WITNESS);

  const pk = i.providerPubkey.toLowerCase();
  for (const p of proofs) {
    const lock = validateBlindfoldLock(p.secret);
    if (!lock.ok || !lock.signers.includes(pk)) return fail(R.WRONG_LOCK);
  }
  return { ok: true, proofs };
}
