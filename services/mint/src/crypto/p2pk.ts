import { BlindfoldErrorCode, CashuErrorCode, validateBlindfoldLock } from "@blindfold/protocol";
import {
  Amount, getP2PKWitnessSignatures, getValidSigners, hashToCurve, pointFromHex, verifyP2PKSpendingConditions,
  verifyUnblindedSignature, type Proof,
} from "@cashu/cashu-ts";
import { MintError } from "../errors.js";
import type { Keysets } from "./keyset.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

export interface NormalProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
  witness?: unknown;
}

export const proofY = (secret: string) => hashToCurve(utf8(secret)).toHex(true);

/**
 * Checks 2 to 5 of 00 section 5.6 for one proof. Returns the signer key (lowercase hex) and Y.
 * Whether that key is an active provider (check 6) is the caller's job.
 */
export function verifyLockedProof(p: NormalProof, keysets: Keysets): { signer: string; y: string } {
  const ks = keysets.requireKnown(p.id);
  if (ks.unit !== "usd") throw new MintError(CashuErrorCode.KEYSET_NOT_FOUND, "keyset unit is not usd");
  if (!ks.keys[String(p.amount)]) throw new MintError(CashuErrorCode.KEYSET_INACTIVE, "amount not in keyset");
  const priv = keysets.priv(p.id, p.amount);
  if (!priv) throw new MintError(CashuErrorCode.KEYSET_NOT_FOUND, "no private key for this keyset");

  let validC = false;
  try {
    validC = verifyUnblindedSignature({ C: pointFromHex(p.C), secret: utf8(p.secret), id: p.id }, priv);
  } catch { /* invalid point */ }
  if (!validC) throw new MintError(CashuErrorCode.TOKEN_NOT_VERIFIED, "invalid proof");

  const lock = validateBlindfoldLock(p.secret);
  if (!lock.ok) throw new MintError(BlindfoldErrorCode.INVALID_LOCK, `bad lock: ${lock.reason}`);

  const proof = { amount: Amount.from(p.amount), id: p.id, secret: p.secret, C: p.C, witness: p.witness } as Proof;
  let valid: string[];
  try {
    const r = verifyP2PKSpendingConditions(proof);
    if (!r.success || r.path !== "MAIN") throw new Error("spend path");
    valid = getValidSigners(getP2PKWitnessSignatures(proof.witness), p.secret, lock.signers);
  } catch {
    throw new MintError(CashuErrorCode.TOKEN_NOT_VERIFIED, "missing or invalid signature");
  }
  if (valid.length !== 1) throw new MintError(CashuErrorCode.TOKEN_NOT_VERIFIED, `expected exactly one valid signer, got ${valid.length}`);
  return { signer: valid[0].toLowerCase(), y: proofY(p.secret) };
}
