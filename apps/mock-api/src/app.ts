import { Hono, type Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { USDC_DEVNET_MINT, SOLANA_DEVNET_CAIP2, centsToBaseUnits } from "@blindfold/protocol";
import { depthData, marketData } from "./data/marketData.js";
import { BlindfoldFacilitator, type Logger } from "./x402/blindfoldFacilitator.js";
import { CashuServerScheme } from "./x402/cashuServerScheme.js";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { ExactOptions } from "./x402/exactBaseline.js";
import type { KeysetSource } from "./x402/keysets.js";
import type { RedeemClient } from "./x402/redeemClient.js";

export interface AppOptions {
  mintUrl: string;
  providerSecretKey: string;
  priceCents?: number;
  depthPriceCents?: number;
  usdcMint?: string;
  providerId?: number;
  redeem?: RedeemClient;
  keysets?: KeysetSource;
  redeemTimeoutMs?: number;
  log?: Logger;
  /** Replaces the paid data handler (runs only after settle). For demos such as a poisoned response. */
  dataHandler?: (c: Context, topic: string) => Response | Promise<Response>;
  /** Baseline (00 section 7.1): also accept the standard x402 `exact` scheme on the paid routes (public onchain transfer). */
  exact?: ExactOptions;
}

const WHALE_FLOW = "whale flow: net USD bought by whale wallets in the last hour";
const DEPTH = "order-book depth: five levels a side";

/** No globals: each call builds an independent provider, so a demo can mount several. */
export function createApp(o: AppOptions) {
  const price = o.priceCents ?? 5;
  const depthPrice = o.depthPriceCents ?? 10;
  const asset = o.usdcMint ?? USDC_DEVNET_MINT;
  const log = o.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  const facilitator = new BlindfoldFacilitator({
    mintUrl: o.mintUrl, providerSecretKey: o.providerSecretKey, redeem: o.redeem, keysets: o.keysets,
    redeemTimeoutMs: o.redeemTimeoutMs, providerId: o.providerId, log,
  });
  const pubkey = facilitator.providerPubkey;
  const resourceServer = new x402ResourceServer(o.exact ? [facilitator, o.exact.facilitator] : [facilitator]).register(
    SOLANA_DEVNET_CAIP2, new CashuServerScheme({ mintUrl: o.mintUrl, providerPubkey: pubkey }),
  );
  if (o.exact) resourceServer.register(SOLANA_DEVNET_CAIP2, new ExactSvmScheme());
  const route = (cents: number, description: string, memo?: string) => ({
    accepts: [
      { scheme: "cashu", network: SOLANA_DEVNET_CAIP2, payTo: pubkey, price: { amount: String(centsToBaseUnits(cents)), asset } },
      // Clients pick the scheme they have registered: the Blindfold wallet pays cashu, a standard x402 client exact.
      ...(o.exact ? [{
        scheme: "exact", network: SOLANA_DEVNET_CAIP2, payTo: o.exact.payTo, price: { amount: String(centsToBaseUnits(cents)), asset },
        ...(memo ? { extra: { memo } } : {}),
      }] : []),
    ],
    description,
    mimeType: "application/json",
  });
  // Per-token routes come first (the first matching route wins) so their exact payments carry the token's memo.
  const tagged: Record<string, ReturnType<typeof route>> = {};
  for (const t of o.exact?.memoTopics ?? []) {
    if (!/^[a-z0-9]{1,16}$/.test(t)) throw new Error(`memo topic must be 1-16 lowercase letters or digits: ${t}`);
    tagged[`GET /v1/data/${t}/depth`] = route(depthPrice, DEPTH, `depth/${t.toUpperCase()}`);
    tagged[`GET /v1/data/${t}`] = route(price, WHALE_FLOW, `whale-flow/${t.toUpperCase()}`);
  }

  const app = new Hono();
  // Request log. The unpaid challenge and served lines; rejections are logged by the facilitator (it knows the reason).
  app.use(async (c, next) => {
    const t = Date.now();
    const paid = c.req.header("PAYMENT-SIGNATURE") !== undefined;
    await next();
    if (c.req.path === "/health") return;
    if (c.res.status === 402 && !paid) log({ ts: new Date().toISOString(), route: c.req.path, outcome: "challenge", latency_ms: Date.now() - t });
    else if (c.res.status < 300 && paid) log({ ts: new Date().toISOString(), route: c.req.path, outcome: "served", latency_ms: Date.now() - t });
  });
  app.get("/health", (c) => c.json({ ok: true, pubkey, provider_id: o.providerId ?? 0 }));
  app.use(paymentMiddleware({
    ...tagged,
    "GET /v1/data/:topic": route(price, WHALE_FLOW),
    "GET /v1/data/:topic/depth": route(depthPrice, DEPTH),
  } as never, resourceServer));
  app.get("/v1/data/:topic/depth", (c) => c.json(depthData(c.req.param("topic"))));
  app.get("/v1/data/:topic", (c) => {
    const topic = c.req.param("topic");
    return o.dataHandler ? o.dataHandler(c, topic) : c.json(marketData(topic));
  });
  return Object.assign(app, { providerPubkey: pubkey, facilitator });
}

/** A fetch handler that presents requests under PUBLIC_URL, so x402 `resource.url` is the public one. */
export function withPublicUrl(app: Hono, publicUrl: string): (req: Request) => Response | Promise<Response> {
  const base = new URL(publicUrl);
  return (req) => {
    const u = new URL(req.url);
    u.protocol = base.protocol;
    u.host = base.host;
    return app.fetch(new Request(u, req));
  };
}
