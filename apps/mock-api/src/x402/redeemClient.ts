import type { RedeemResponse, WireProof } from "@blindfold/protocol";

export type RedeemResult = RedeemResponse;

/** The mint answered with a Cashu error (HTTP 400 {detail, code}). */
export class RedeemError extends Error {
  constructor(public code: number, public detail: string) {
    super(`redeem failed ${code}: ${detail}`);
    this.name = "RedeemError";
  }
}

/** Timeout, connection error or 5xx: the state at the mint is unknown. */
export class MintUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MintUnavailableError";
  }
}

export interface RedeemClient {
  redeem(proofs: WireProof[]): Promise<RedeemResult>;
}

/** POST {mintUrl}/v1/blindfold/redeem. No automatic retry (a retry after a committed call would read as 11001). */
export class HttpRedeemClient implements RedeemClient {
  constructor(private mintUrl: string, private timeoutMs = 8000, private fetchImpl: typeof fetch = fetch) {}

  async redeem(proofs: WireProof[]): Promise<RedeemResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.mintUrl.replace(/\/+$/, "")}/v1/blindfold/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proofs }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new MintUnavailableError(`redeem request failed: ${(e as Error).message}`);
    }
    if (res.status >= 500) throw new MintUnavailableError(`mint returned HTTP ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MintUnavailableError(`mint returned an unreadable HTTP ${res.status} body`);
    }
    const b = body as Partial<RedeemResponse> & { code?: unknown; detail?: unknown };
    if (res.ok) {
      if (typeof b.redemption_id !== "string" || typeof b.amount !== "number" || typeof b.provider_id !== "number") {
        throw new MintUnavailableError("mint returned a malformed redeem response");
      }
      return { provider_id: b.provider_id, amount: b.amount, redemption_id: b.redemption_id };
    }
    if (typeof b.code === "number") throw new RedeemError(b.code, String(b.detail ?? ""));
    throw new MintUnavailableError(`mint returned HTTP ${res.status} without an error code`);
  }
}
