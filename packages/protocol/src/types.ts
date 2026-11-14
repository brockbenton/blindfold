import { Amount, type Proof, type SerializedBlindedMessage } from "@cashu/cashu-ts";

export type {
  Proof,
  ProofLike,
  BlindSignature,
  SerializedBlindedMessage,
  P2PKOptions,
  P2PKWitness,
  MintKeys,
  Token,
} from "@cashu/cashu-ts";

/** Optional entry of TokenFile.pending (section 3.4). */
/** NUT-00 BlindedMessage (cashu-ts names it SerializedBlindedMessage). */
export type BlindedMessage = SerializedBlindedMessage;

export interface PendingEntry {
  proofs: Proof[];
  url: string;
  sent_at: number;
}

/** Agent token file (section 3.4). Readers that do not know `pending` must preserve it. */
export interface TokenFile {
  version: 1;
  mint: string;
  unit: "usd";
  proofs: Proof[];
  pending?: PendingEntry[];
}

/** Proof as it appears in JSON bodies (section 3.4): amount is a number, witness a JSON string. */
export interface WireProof {
  amount: number;
  id: string;
  secret: string;
  C: string;
  witness?: string;
  dleq?: { e: string; s: string; r?: string };
}

/** Provider entry from GET /v1/blindfold/providers (section 5.5). */
export interface ProviderInfo {
  provider_id: number;
  pubkey: string;
  name: string | null;
  url: string | null;
  price_cents: number | null;
  topics: string[];
  active: boolean;
}

export interface RedeemRequest {
  proofs: WireProof[];
}

export interface RedeemResponse {
  provider_id: number;
  amount: number;
  redemption_id: string;
}

export interface MintQuoteSolanaUsdcRequest {
  unit: "usd";
  amount: number;
  /** 33-byte compressed hex, NUT-20 quote key. */
  pubkey: string;
}

export interface MintQuoteSolanaUsdcResponse {
  quote: string;
  /** The deposit_ref: 32 random bytes, hex. */
  request: string;
  unit: "usd";
  method: "solana-usdc";
  amount: number;
  expiry: number;
  pubkey: string;
  amount_paid: number;
  amount_issued: number;
  updated_at: number;
  vault_program: string;
  usdc_mint: string;
  amount_base_units: string;
}

export interface CashuErrorBody {
  detail: string;
  code: number;
}

export interface ProviderBalance {
  provider_id: number;
  balance: number;
}

export type AdminBalancesResponse = ProviderBalance[];

export interface Payout {
  provider_id: number;
  amount: number;
}

export type AdminSettleResponse =
  | { batch_id: number; payouts: Payout[]; tx: string }
  | { batch_id: null };

export interface AdminReconcileResponse {
  vault_balance: number;
  deposited: number;
  issued: number;
  redeemed: number;
  settled: number;
}

export interface NutCheckStateResponse {
  states: { Y: string; state: "UNSPENT" | "SPENT"; witness: string | null }[];
}

/** cashu-ts Proof to wire form. Object witnesses are serialized to a JSON string. */
export function toWireProof(proof: Proof | (Omit<Proof, "amount"> & { amount: number | string | bigint })): WireProof {
  const amt = proof.amount;
  const amount = typeof amt === "object" ? amt.toNumber() : Number(amt);
  if (!Number.isSafeInteger(amount)) throw new RangeError(`unsafe proof amount ${String(amt)}`);
  const out: WireProof = { amount, id: proof.id, secret: proof.secret, C: proof.C };
  if (proof.dleq) out.dleq = proof.dleq;
  const w = proof.witness;
  if (w !== undefined && w !== null) out.witness = typeof w === "string" ? w : JSON.stringify(w);
  return out;
}

/**
 * Wire proof to cashu-ts Proof. The witness stays a string: cashu-ts accepts string witnesses
 * and the mint accepts either form on input.
 */
export function fromWireProof(wire: WireProof | (Omit<WireProof, "amount"> & { amount: number | string })): Proof {
  const out: Proof = { amount: Amount.from(wire.amount), id: wire.id, secret: wire.secret, C: wire.C };
  if (wire.dleq) out.dleq = wire.dleq;
  if (wire.witness !== undefined) out.witness = wire.witness;
  return out;
}

/** GET /v1/blindfold/reserves (section 5.5a), all cents. */
export interface ReservesResponse {
  issued: number;
  settled: number;
  outstanding: number;
  keyset_id: string;
  updated_at: number;
}
