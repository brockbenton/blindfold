import { verifyMintSignatures, type HasKeysetKeys, type Proof } from "@cashu/cashu-ts";

/** NUT-12 check on freshly issued proofs. DLEQ is required, any invalid entry fails. */
export async function verifyDleq(proofs: Proof[], keyset: HasKeysetKeys): Promise<{ ok: boolean; invalid: number }> {
  const r = await verifyMintSignatures(proofs, () => keyset, { require: true });
  return { ok: r.invalid.length === 0, invalid: r.invalid.length };
}
