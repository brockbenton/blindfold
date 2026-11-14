// Constants and conventions from docs/design/00-interfaces.md section 2, plus error codes.

export const CASHU_UNIT = "usd";
export const USDC_DECIMALS = 6;
/** Conversion happens only at the vault boundary. */
export const BASE_UNITS_PER_CENT = 10_000n;

/** Keyset amounts: 1, 2, 4, ... 4096 (2^0 to 2^12). */
export const KEYSET_AMOUNTS: readonly number[] = Array.from({ length: 13 }, (_, i) => 2 ** i);
export const KEYSET_INPUT_FEE_PPK = 0;

export const MAX_DEPOSIT_CENTS = 5000;
export const QUOTE_EXPIRY_S = 3600;
export const DEPOSIT_POLL_MS = 2000;
export const SETTLE_INTERVAL_S = 60;
export const MAX_PAYOUTS_PER_BATCH = 8;
/** Redeem and mint request limits from sections 5.4 and 5.6. */
export const MAX_REDEEM_PROOFS = 64;
export const MAX_MINT_OUTPUTS = 256;

/** Demo only; a real deployment would use finalized. */
export const SOLANA_COMMITMENT = "confirmed" as const;

export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEFAULT_MINT_URL = "http://localhost:3338";

export const X402_VERSION = 2;
export const CASHU_SCHEME = "cashu";
/** CAIP-2 id for Solana devnet. */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export const SIGFLAG_INPUTS = "SIG_INPUTS";

/** Cashu standard error codes used by the mint (NUT error_codes.md). */
export const CashuErrorCode = {
  TOKEN_NOT_VERIFIED: 10001,
  PROOF_ALREADY_SPENT: 11001,
  OUTPUTS_ALREADY_SIGNED: 11003,
  AMOUNT_OUTSIDE_LIMIT: 11006,
  DUPLICATE_INPUTS: 11007,
  DUPLICATE_OUTPUTS: 11008,
  UNIT_NOT_SUPPORTED: 11013,
  TOO_MANY_INPUTS: 11014,
  TOO_MANY_OUTPUTS: 11015,
  KEYSET_NOT_FOUND: 12001,
  KEYSET_INACTIVE: 12002,
  QUOTE_NOT_FOUND: 20001,
  MINTING_DISABLED_OR_NOTHING_MINTABLE: 20002,
  QUOTE_SIGNATURE_INVALID: 20008,
  QUOTE_PUBKEY_REQUIRED: 20009,
} as const;

/** Blindfold-specific codes, 7xxxx. */
export const BlindfoldErrorCode = {
  /** Secret is not a well formed Blindfold lock (section 5.6 check 4). */
  INVALID_LOCK: 70001,
  /** Signing key is not an active registered provider. */
  PROVIDER_NOT_REGISTERED: 70002,
  /** Proofs in one request were signed by different providers. */
  MIXED_PROVIDERS: 70003,
} as const;

export const ErrorCode = { ...CashuErrorCode, ...BlindfoldErrorCode } as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** x402 settle errorReason values from section 7.3. `redeem_failed_<code>` is built by redeemFailedReason. */
export const SettleErrorReason = {
  MALFORMED_TOKEN: "malformed_token",
  WRONG_MINT: "wrong_mint",
  WRONG_UNIT: "wrong_unit",
  WRONG_AMOUNT: "wrong_amount",
  WRONG_LOCK: "wrong_lock",
  UNEXPECTED_WITNESS: "unexpected_witness",
  MINT_UNAVAILABLE: "mint_unavailable",
} as const;

export function redeemFailedReason(mintCode: number): string {
  return `redeem_failed_${mintCode}`;
}
