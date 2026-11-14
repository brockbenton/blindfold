import { CASHU_SCHEME, CASHU_UNIT, SOLANA_DEVNET_CAIP2 } from "./constants.js";
import { baseUnitsToCents } from "./units.js";
import { isCompressedPubkeyHex } from "./lock.js";

/** The `extra` object of a cashu PaymentRequirements entry (section 7.1). */
export interface CashuExtra {
  mints: string[];
  unit: "usd";
  nut10: { k: "P2PK"; d: string };
  paymentFlow?: "upfront";
}

/** The `payload` of a cashu PaymentPayload (section 7.2). */
export interface CashuPayload {
  token: string;
}

export function cashuExtra(opts: { mintUrl: string; providerPubkey: string }): CashuExtra {
  return {
    mints: [opts.mintUrl],
    unit: CASHU_UNIT,
    nut10: { k: "P2PK", d: opts.providerPubkey },
  };
}

export type CashuRequirementsErrorCode =
  | "wrong_scheme"
  | "wrong_network"
  | "bad_amount"
  | "pay_to_mismatch"
  | "wrong_unit"
  | "missing_mints"
  | "bad_nut10";

export class CashuRequirementsError extends Error {
  constructor(public readonly code: CashuRequirementsErrorCode, message: string) {
    super(message);
    this.name = "CashuRequirementsError";
  }
}

/** Minimal structural view of an x402 PaymentRequirements entry. */
export interface PaymentRequirementsLike {
  scheme: string;
  network: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
}

export interface ParsedCashuRequirements {
  cents: number;
  mints: string[];
  unit: "usd";
  providerPubkey: string;
}

export function parseCashuRequirements(req: PaymentRequirementsLike): ParsedCashuRequirements {
  if (req.scheme !== CASHU_SCHEME) throw new CashuRequirementsError("wrong_scheme", `scheme is ${req.scheme}`);
  if (req.network !== SOLANA_DEVNET_CAIP2) throw new CashuRequirementsError("wrong_network", `network is ${req.network}`);
  let cents: number;
  try {
    cents = baseUnitsToCents(req.amount);
  } catch (e) {
    throw new CashuRequirementsError("bad_amount", (e as Error).message);
  }
  if (cents <= 0) throw new CashuRequirementsError("bad_amount", "amount must be positive");
  const extra = (req.extra ?? {}) as Partial<CashuExtra>;
  if (extra.unit !== CASHU_UNIT) throw new CashuRequirementsError("wrong_unit", `unit is ${String(extra.unit)}`);
  const mints = extra.mints;
  if (!Array.isArray(mints) || mints.length === 0 || !mints.every((m) => typeof m === "string")) {
    throw new CashuRequirementsError("missing_mints", "extra.mints missing or empty");
  }
  const nut10 = extra.nut10;
  if (!nut10 || nut10.k !== "P2PK" || typeof nut10.d !== "string") {
    throw new CashuRequirementsError("bad_nut10", "extra.nut10 must be a P2PK lock");
  }
  if (req.payTo !== nut10.d) throw new CashuRequirementsError("pay_to_mismatch", "payTo does not equal extra.nut10.d");
  if (!isCompressedPubkeyHex(nut10.d)) throw new CashuRequirementsError("bad_nut10", "extra.nut10.d is not a compressed pubkey");
  return { cents, mints: [...mints], unit: CASHU_UNIT, providerPubkey: nut10.d };
}
