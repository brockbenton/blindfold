// The gateway's side of the upstream vendor: quote its x402 price, then buy with a standard `exact` payment from the
// gateway's own wallet. Requests are built from scratch, so nothing from the agent's request reaches the vendor.

/** The only headers the gateway ever sends upstream. No cookies, auth, forwarding or client headers. */
export const UPSTREAM_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: "application/json",
  "user-agent": "blindfold-gateway/0.1",
});

export interface UpstreamQuote {
  /** Price in the asset's base units (USDC: 6 decimals). */
  amountBase: bigint;
  payTo: string;
}

export interface UpstreamResult {
  status: number;
  body: Uint8Array;
  contentType: string;
  /** The `exact` payment's transaction signature, from the vendor's PAYMENT-RESPONSE header. */
  transaction?: string;
}

/** `fetch` that pays x402 `exact` from the gateway wallet, refusing any payment above `maxBase`. */
export type PayFetchFactory = (maxBase: bigint) => typeof fetch;

export type UpstreamFailure = "upstream_unavailable" | "upstream_not_x402" | "upstream_price_too_high" | "upstream_payment_failed" | "upstream_error";

export class UpstreamError extends Error {
  constructor(readonly reason: UpstreamFailure, detail: string, readonly retryable = false) {
    super(`${reason}: ${detail}`);
  }
}

export interface UpstreamClientOptions {
  payFetch: PayFetchFactory;
  /** CAIP-2 network and asset the gateway pays in. */
  network: string;
  asset: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long a price quote is reused. Default 30 s. */
  quoteTtlMs?: number;
  now?: () => number;
}

const decode = (h: string) => JSON.parse(Buffer.from(h, "base64").toString("utf8"));

export class UpstreamClient {
  private quotes = new Map<string, { quote: UpstreamQuote; at: number }>();
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private ttl: number;
  private now: () => number;
  private payFetches = new Map<bigint, typeof fetch>();

  constructor(private o: UpstreamClientOptions) {
    this.fetchImpl = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 15_000;
    this.ttl = o.quoteTtlMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  /** The vendor's current `exact` price for `url`, from its unpaid 402 challenge. Cached for `quoteTtlMs`. */
  async quote(url: string): Promise<UpstreamQuote> {
    const hit = this.quotes.get(url);
    if (hit && this.now() - hit.at < this.ttl) return hit.quote;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: UPSTREAM_HEADERS, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new UpstreamError("upstream_unavailable", String((e as Error)?.message ?? e), true);
    }
    await res.body?.cancel();
    if (res.status !== 402) throw new UpstreamError(res.status >= 500 ? "upstream_unavailable" : "upstream_not_x402", `HTTP ${res.status} to an unpaid request`, res.status >= 500);
    const header = res.headers.get("PAYMENT-REQUIRED");
    let accepts: { scheme?: string; network?: string; asset?: string; amount?: string; payTo?: string }[];
    try {
      accepts = decode(header ?? "").accepts;
      if (!Array.isArray(accepts)) throw new Error("no accepts");
    } catch {
      throw new UpstreamError("upstream_not_x402", "402 without a readable PAYMENT-REQUIRED header");
    }
    const exact = accepts.find((a) => a.scheme === "exact" && a.network === this.o.network && a.asset === this.o.asset);
    if (!exact || !/^\d+$/.test(exact.amount ?? "") || typeof exact.payTo !== "string") {
      throw new UpstreamError("upstream_not_x402", `no exact offer in ${this.o.asset} on ${this.o.network}`);
    }
    const quote = { amountBase: BigInt(exact.amount!), payTo: exact.payTo };
    this.quotes.set(url, { quote, at: this.now() });
    return quote;
  }

  /** Buys `url` from the vendor, paying at most `maxBase`. The wallet refuses anything above it. */
  async buy(url: string, maxBase: bigint): Promise<UpstreamResult> {
    let pay = this.payFetches.get(maxBase);
    if (!pay) this.payFetches.set(maxBase, (pay = this.o.payFetch(maxBase)));
    let res: Response;
    try {
      res = await pay(url, { headers: UPSTREAM_HEADERS, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      this.quotes.delete(url);
      throw new UpstreamError("upstream_payment_failed", String((e as Error)?.message ?? e), true);
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (res.status === 402) {
      this.quotes.delete(url);
      throw new UpstreamError("upstream_payment_failed", "vendor refused the payment (HTTP 402)");
    }
    if (res.status >= 400) {
      this.quotes.delete(url);
      throw new UpstreamError("upstream_error", `HTTP ${res.status}`, res.status >= 500);
    }
    let transaction: string | undefined;
    const pr = res.headers.get("PAYMENT-RESPONSE");
    if (pr) {
      try {
        transaction = decode(pr).transaction || undefined;
      } catch {
        // A vendor that served the data but sent an unreadable receipt still delivered.
      }
    }
    return { status: res.status, body, contentType: res.headers.get("content-type") ?? "application/octet-stream", transaction };
  }
}
