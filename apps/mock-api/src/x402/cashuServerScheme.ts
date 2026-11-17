import type { AssetAmount, Network, PaymentRequirements, Price, SchemeNetworkServer } from "@x402/core/types";
import { BLINDFOLD_SCHEME, cashuExtra } from "@blindfold/protocol";

/** x402 server scheme `blindfold` (00 section 7.1). Prices are AssetAmounts in USDC base units. */
export class CashuServerScheme implements SchemeNetworkServer {
  readonly scheme = BLINDFOLD_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = { default: { supported: ["upfront"], default: "upfront" } } as const;

  constructor(private o: { mintUrl: string; providerPubkey: string }) {}

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price && "asset" in price) return price as AssetAmount;
    throw new Error("cashu scheme only accepts { amount, asset } prices");
  }

  async enhancePaymentRequirements(req: PaymentRequirements): Promise<PaymentRequirements> {
    return { ...req, extra: { ...req.extra, ...cashuExtra({ mintUrl: this.o.mintUrl, providerPubkey: this.o.providerPubkey }) } };
  }
}
