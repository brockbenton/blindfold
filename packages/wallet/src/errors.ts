export type RefusalReason =
  | "bad_request"
  | "unit"
  | "mint"
  | "over_cap"
  | "provider_not_allowed"
  | "provider_not_in_signer_set"
  | "insufficient_exact"
  | "insufficient_balance"
  | "approval_denied"
  | "approval_timeout";

/** Thrown before any proof leaves the wallet. The message format lets us recognise it after x402 wraps it. */
export class PaymentRefused extends Error {
  constructor(public reason: RefusalReason, public detail: Record<string, unknown> = {}) {
    super(`PaymentRefused:${reason}`);
    this.name = "PaymentRefused";
  }
}

/** The paid retry was not settled (after checkstate recovery). `status` is 402 for any settle failure. */
export class PaymentFailed extends Error {
  errorReason?: string;
  constructor(
    public status: number,
    public body: string,
    public recovered: { returned: number; dropped: number },
    errorReason?: string,
  ) {
    super(`PaymentFailed: paid retry returned HTTP ${status}`);
    this.name = "PaymentFailed";
    if (errorReason) this.errorReason = errorReason;
  }
}

export class TokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenFileError";
  }
}
