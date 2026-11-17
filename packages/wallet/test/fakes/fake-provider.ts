// x402 server with the real @x402/hono middleware, as in spikes/x402-cashu/spike.ts, plus failure modes.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { getDecodedToken, getPubKeyFromPrivKey, signP2PKProofs } from "@cashu/cashu-ts";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, signerSet } from "@blindfold/protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NET = SOLANA_DEVNET_CAIP2;

export type ProviderMode = "ok" | "rejectSettle" | "dropResponse" | "hostile" | "hostilePrice";

export interface FakeProviderOptions {
  sk: string;
  mintUrl: string;
  /** Marks the proofs spent at the fake mint (for dropResponse). */
  spend: (secret: string) => void;
  priceCents?: number;
  mode?: ProviderMode;
  /** Key advertised in `hostile` mode. */
  attackerKey?: string;
  /** Mint keyset ids for token decoding. */
  keysetIds: string[];
}

export class FakeProvider {
  readonly pubkey: string;
  mode: ProviderMode;
  settleCalls = 0;
  handlerRuns = 0;
  paidRequests = 0;
  url = "";
  private server?: ReturnType<typeof serve>;

  constructor(private o: FakeProviderOptions) {
    this.pubkey = hex(getPubKeyFromPrivKey(Buffer.from(o.sk, "hex")));
    this.mode = o.mode ?? "ok";
  }

  async start(port = 0): Promise<string> {
    const o = this.o;
    const price = o.priceCents ?? 5;
    const self = this;
    const facilitator = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "blindfold", network: NET }], extensions: [], signers: {} };
      },
      async verify() {
        return { isValid: true };
      },
      async settle(payload: any, req: any) {
        self.settleCalls++;
        const fail = (errorReason: string) => ({ success: false, errorReason, transaction: "", network: NET });
        if (self.mode === "rejectSettle") return fail("rejected");
        try {
          const token = getDecodedToken(payload.payload.token, o.keysetIds);
          const want = Number(BigInt(req.amount) / 10_000n);
          const total = token.proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
          if (total !== want) return fail("wrong_amount");
          if (!token.proofs.every((p) => signerSet(p.secret).includes(self.pubkey))) return fail("wrong_lock");
          signP2PKProofs(token.proofs, o.sk);
          if (self.mode === "dropResponse") {
            token.proofs.forEach((p) => o.spend(p.secret));
            return fail("response_lost");
          }
          return { success: true, transaction: `redemption-${self.settleCalls}`, network: NET, amount: req.amount };
        } catch {
          return fail("malformed_token");
        }
      },
    };
    const advertisedKey = () => (self.mode === "hostile" ? o.attackerKey! : self.pubkey);
    const advertisedPrice = () => (self.mode === "hostilePrice" ? 10_000 : price);
    const scheme = {
      scheme: "blindfold",
      defaultAssetTransferMethod: "default",
      paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
      async parsePrice(p: any) {
        return p;
      },
      async enhancePaymentRequirements(req: any) {
        const d = advertisedKey();
        return { ...req, payTo: d, amount: String(BigInt(advertisedPrice()) * 10_000n), extra: { ...req.extra, mints: [o.mintUrl], unit: "usd", nut10: { k: "P2PK", d } } };
      },
    };
    const rs = new x402ResourceServer([facilitator as any]).register(NET, scheme as any);
    const app = new Hono();
    app.use(async (c, next) => {
      if (c.req.header("PAYMENT-SIGNATURE")) self.paidRequests++;
      await next();
    });
    app.use(paymentMiddleware({
      "GET /v1/data/:topic": {
        accepts: [{ scheme: "blindfold", network: NET, payTo: self.pubkey, price: { amount: String(price * 10_000), asset: USDC_DEVNET_MINT } }],
        description: "market data",
      },
    } as any, rs));
    app.get("/v1/data/:topic", (c) => {
      self.handlerRuns++;
      return c.json({ topic: c.req.param("topic"), price: 172.4 });
    });
    this.server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 50));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop() {
    (this.server as any)?.closeAllConnections?.();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
