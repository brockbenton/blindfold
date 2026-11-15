import { getEncodedToken } from "@cashu/cashu-ts";
import type { PaymentPayloadResult, PaymentRequirements, SchemeClientHooks, SchemeNetworkClient } from "@x402/core/types";
import {
  CASHU_SCHEME, CashuRequirementsError, fromWireProof, parseCashuRequirements, type WireProof,
} from "@blindfold/protocol";
import { PaymentRefused, type RefusalReason } from "./errors.js";
import { selectExact } from "./select.js";
import type { PendingWire, StoredFile } from "./store.js";

/** What the client scheme needs from the wallet. All calls happen under the wallet's spend mutex. */
export interface SpendHost {
  readonly file: StoredFile;
  readonly maxPerCallCents: number;
  readonly allowlist: readonly string[];
  readonly usdcMint: string;
  readonly currentUrl: string;
  /** Move `chosen` from proofs to a new pending entry and persist, before the paid retry is sent. */
  markPending(chosen: WireProof[]): Promise<PendingWire>;
  /** Called by the hook: settled (drop) or not (checkstate recovery). */
  paymentSettled(token: string, ok: boolean, errorReason?: string): Promise<void>;
  rememberInFlight(token: string, entry: PendingWire): void;
  refused(e: PaymentRefused): void;
}

const normalizeMint = (u: string) => {
  try {
    const x = new URL(u);
    // URL normalizes scheme/host. Paths and query strings remain case-sensitive
    // and can identify distinct mints on the same server.
    x.pathname = x.pathname.replace(/\/+$/, "");
    return x.href;
  } catch {
    return u.replace(/\/+$/, "");
  }
};

const PARSE_REASON: Record<string, RefusalReason> = { wrong_unit: "unit" };

export class CashuClientScheme implements SchemeNetworkClient {
  readonly scheme = CASHU_SCHEME;
  readonly schemeHooks: SchemeClientHooks;

  constructor(private host: SpendHost) {
    this.schemeHooks = {
      onPaymentResponse: async (ctx) => {
        const token = (ctx.paymentPayload.payload as { token?: unknown })?.token;
        if (typeof token !== "string") return;
        const reason = ctx.settleResponse?.errorReason ?? ctx.paymentRequired?.error;
        await this.host.paymentSettled(token, ctx.settleResponse?.success === true, reason);
      },
    };
  }

  async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
    const h = this.host;
    const refuse = (reason: RefusalReason, detail: Record<string, unknown> = {}): never => {
      const e = new PaymentRefused(reason, detail);
      h.refused(e);
      throw e;
    };

    let parsed;
    try {
      parsed = parseCashuRequirements(req);
    } catch (e) {
      if (e instanceof CashuRequirementsError) return refuse(PARSE_REASON[e.code] ?? "bad_request", { message: e.message });
      throw e;
    }
    const { cents, mints, providerPubkey } = parsed;
    if (h.file.unit !== "usd") refuse("unit");
    if (req.asset !== h.usdcMint) refuse("mint", { asset: req.asset });
    if (!mints.some((m) => normalizeMint(m) === normalizeMint(h.file.mint))) refuse("mint", { mints });
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > h.maxPerCallCents) refuse("over_cap", { cents });
    const pk = providerPubkey.toLowerCase();
    if (!h.allowlist.includes(pk)) refuse("provider_not_allowed", { provider: pk });

    const sel = selectExact(h.file.proofs, cents, pk);
    if ("error" in sel) return refuse(sel.error, { cents });

    await h.markPending(sel.chosen);
    const token = getEncodedToken(
      { mint: h.file.mint, unit: "usd", proofs: sel.chosen.map((p) => fromWireProof({ ...p, witness: undefined })) },
      { removeDleq: true },
    );
    h.rememberInFlight(token, h.file.pending![h.file.pending!.length - 1]);
    return { x402Version, payload: { token } };
  }
}
