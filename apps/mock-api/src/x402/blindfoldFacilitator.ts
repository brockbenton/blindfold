import { getDecodedToken, getPubKeyFromPrivKey, signP2PKProofs } from "@cashu/cashu-ts";
import type { FacilitatorClient } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { BLINDFOLD_SCHEME, SOLANA_DEVNET_CAIP2, SettleErrorReason as R, redeemFailedReason, toWireProof } from "@blindfold/protocol";
import { HttpKeysetSource, type KeysetSource } from "./keysets.js";
import { HttpRedeemClient, MintUnavailableError, RedeemError, type RedeemClient } from "./redeemClient.js";
import { verifyToken } from "./verifyToken.js";

export type Logger = (entry: Record<string, unknown>) => void;

export interface BlindfoldFacilitatorOptions {
  mintUrl: string;
  /** secp256k1 hex, 32 bytes. */
  providerSecretKey: string;
  redeem?: RedeemClient;
  keysets?: KeysetSource;
  redeemTimeoutMs?: number;
  /** Sanity check only: a mismatch with the redeem response is logged, not fatal. */
  providerId?: number;
  log?: Logger;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NET = SOLANA_DEVNET_CAIP2;

/** In-process x402 FacilitatorClient: settle = validate, sign with the provider key, redeem at the mint (00 section 7.3). */
export class BlindfoldFacilitator implements FacilitatorClient {
  readonly providerPubkey: string;
  private redeem: RedeemClient;
  private keysets: KeysetSource;
  private log: Logger;
  private timeoutMs: number;

  constructor(private o: BlindfoldFacilitatorOptions) {
    if (!/^[0-9a-fA-F]{64}$/.test(o.providerSecretKey)) throw new Error("providerSecretKey must be 32 bytes of hex");
    this.providerPubkey = hex(getPubKeyFromPrivKey(Buffer.from(o.providerSecretKey, "hex")));
    this.redeem = o.redeem ?? new HttpRedeemClient(o.mintUrl, o.redeemTimeoutMs);
    this.keysets = o.keysets ?? new HttpKeysetSource(o.mintUrl);
    this.timeoutMs = o.redeemTimeoutMs ?? 8000;
    this.log = o.log ?? ((e) => console.log(JSON.stringify(e)));
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: BLINDFOLD_SCHEME, network: NET }], extensions: [], signers: {} };
  }

  /** Not called in the upfront flow. Structural check only: the token decodes. */
  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    const token = (payload.payload as { token?: unknown })?.token;
    try {
      if (typeof token !== "string" || !token.startsWith("cashuB")) throw new Error("not a cashuB token");
      getDecodedToken(token, await this.keysets.ids());
      return { isValid: true };
    } catch {
      return { isValid: false, invalidReason: R.MALFORMED_TOKEN };
    }
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const started = Date.now();
    const out = await this.settleInner(payload, req).catch((): SettleResponse => this.failure(R.MINT_UNAVAILABLE));
    this.log({
      ts: new Date().toISOString(), route: "settle",
      outcome: out.success ? "settled" : `rejected:${out.errorReason}`,
      amount: req.amount, redemption_id: out.success ? out.transaction : undefined, latency_ms: Date.now() - started,
    });
    return out;
  }

  private failure(errorReason: string): SettleResponse {
    return { success: false, errorReason, transaction: "", network: NET };
  }

  private async settleInner(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const v = await verifyToken({
      token: (payload.payload as { token?: unknown })?.token,
      mintUrl: this.o.mintUrl,
      providerPubkey: this.providerPubkey,
      amount: req.amount,
      keysetIds: (x) => this.keysets.ids(x),
    });
    if (!v.ok) return this.failure(v.reason);

    const signed = signP2PKProofs(v.proofs, this.o.providerSecretKey);
    const sigCount = (w: unknown) => {
      try {
        const o = typeof w === "string" ? JSON.parse(w) : w;
        return (o as { signatures?: unknown[] }).signatures?.length ?? 0;
      } catch {
        return 0;
      }
    };
    if (!signed.every((p) => sigCount(p.witness) === 1)) return this.failure(R.WRONG_LOCK);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new MintUnavailableError("redeem timed out")), this.timeoutMs + 500);
      });
      const r = await Promise.race([this.redeem.redeem(signed.map((p) => toWireProof(p))), timeout]);
      if (this.o.providerId !== undefined && r.provider_id !== this.o.providerId) {
        this.log({ ts: new Date().toISOString(), warn: "provider_id mismatch", expected: this.o.providerId, got: r.provider_id });
      }
      return { success: true, transaction: r.redemption_id, network: NET, amount: req.amount };
    } catch (e) {
      if (e instanceof RedeemError) return this.failure(redeemFailedReason(e.code));
      return this.failure(R.MINT_UNAVAILABLE);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
