import { createBlindSignature, createDLEQProof, pointFromHex } from "@cashu/cashu-ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface SignedOutput {
  amount: number;
  id: string;
  C_: string;
  dleq: { s: string; e: string };
}

/** NUT-00 blind signature plus NUT-12 DLEQ. `r` is never sent. Not constant time (cashu-ts). */
export function signOutput(B_hex: string, amount: number, id: string, priv: Uint8Array): SignedOutput {
  const B_ = pointFromHex(B_hex);
  const { C_ } = createBlindSignature(B_, priv, id);
  const d = createDLEQProof(B_, priv);
  return { amount, id, C_: C_.toHex(true), dleq: { s: hex(d.s), e: hex(d.e) } };
}
