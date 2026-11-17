import { Hono, type Context, type Next } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, centsToBaseUnits } from "@blindfold/protocol";
import { BlindfoldFacilitator, type Logger } from "mock-api/x402/blindfoldFacilitator";
import { CashuServerScheme } from "mock-api/x402/cashuServerScheme";
import type { KeysetSource } from "mock-api/x402/keysets";
import type { RedeemClient } from "mock-api/x402/redeemClient";
import { BadParamError, upstreamUrl, type GatewayRoute } from "./routes.js";
import { UpstreamError, type UpstreamClient } from "./upstream.js";

export interface GatewayOptions {
  mintUrl: string;
  /** The gateway's Blindfold provider key (secp256k1 hex): tokens must be locked to it, and the vault pays it. */
  providerSecretKey: string;
  routes: GatewayRoute[];
  upstream: UpstreamClient;
  usdcMint?: string;
  providerId?: number;
  redeem?: RedeemClient;
  keysets?: KeysetSource;
  redeemTimeoutMs?: number;
  log?: Logger;
}

type Vars = { Variables: { purchase: { url: string; maxBase: bigint; route: GatewayRoute } } };

/**
 * A Blindfold provider that resells upstream x402 `exact` endpoints (docs/design/06-gateway.md).
 *
 * Order per paid call: 1) quote the vendor and check its price, before any payment; 2) redeem the agent's tokens at
 * the mint (the x402 middleware's upfront settlement); 3) buy from the vendor with the gateway wallet; 4) serve.
 */
export function createGateway(o: GatewayOptions) {
  const asset = o.usdcMint ?? USDC_DEVNET_MINT;
  const log = o.log ?? ((e: Record<string, unknown>) => console.log(JSON.stringify(e)));
  const facilitator = new BlindfoldFacilitator({
    mintUrl: o.mintUrl, providerSecretKey: o.providerSecretKey, redeem: o.redeem, keysets: o.keysets,
    redeemTimeoutMs: o.redeemTimeoutMs, providerId: o.providerId, log,
  });
  const pubkey = facilitator.providerPubkey;
  const resourceServer = new x402ResourceServer([facilitator]).register(
    SOLANA_DEVNET_CAIP2, new CashuServerScheme({ mintUrl: o.mintUrl, providerPubkey: pubkey }),
  );
  const ts = () => new Date().toISOString();
  const app = new Hono<Vars>();

  app.get("/health", (c) => c.json({
    ok: true, pubkey, provider_id: o.providerId ?? 0,
    routes: o.routes.map((r) => ({ path: r.path, price_cents: r.priceCents, upstream_host: new URL(r.upstream.replace(/:[a-zA-Z0-9]+/g, "x")).host })),
  }));

  // 1) Before the payment middleware: an agent is never charged for a call the vendor cannot serve at our price.
  const preflight = (route: GatewayRoute) => async (c: Context<Vars>, next: Next) => {
    let url: string;
    try {
      url = upstreamUrl(route, c.req.param() as Record<string, string>, new URL(c.req.url).searchParams);
    } catch (e) {
      if (e instanceof BadParamError) return c.json({ error: "bad_request", detail: e.message }, 400);
      throw e;
    }
    const maxBase = centsToBaseUnits(route.maxUpstreamCents);
    try {
      const q = await o.upstream.quote(url);
      if (q.amountBase > maxBase) {
        log({ ts: ts(), route: route.path, outcome: "refused:upstream_price_too_high", upstream_base: String(q.amountBase), max_base: String(maxBase) });
        return c.json({ error: "upstream_price_too_high" }, 502);
      }
    } catch (e) {
      if (!(e instanceof UpstreamError)) throw e;
      log({ ts: ts(), route: route.path, outcome: `refused:${e.reason}`, detail: e.message });
      return c.json({ error: e.reason }, 502);
    }
    c.set("purchase", { url, maxBase, route });
    await next();
  };
  for (const r of o.routes) app.on("GET", r.path, preflight(r));

  // 2) Blindfold payment: tokens locked to the gateway's key, redeemed at the mint before the handler runs.
  app.use(paymentMiddleware(Object.fromEntries(o.routes.map((r) => [`GET ${r.path}`, {
    accepts: [{ scheme: "blindfold", network: SOLANA_DEVNET_CAIP2, payTo: pubkey, price: { amount: String(centsToBaseUnits(r.priceCents)), asset } }],
    description: r.description,
    mimeType: "application/json",
  }])) as never, resourceServer));

  // 3) Paid: buy upstream with the gateway wallet (one retry on transient failures), 4) serve the vendor's response.
  const serveRoute = async (c: Context<Vars>) => {
    const { url, maxBase, route } = c.get("purchase");
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const got = await o.upstream.buy(url, maxBase);
        log({ ts: ts(), route: route.path, outcome: "upstream_bought", transaction: got.transaction, latency_ms: Date.now() - started });
        const headers = new Headers({ "content-type": got.contentType });
        if (got.transaction) headers.set("x-upstream-payment", got.transaction);
        return new Response(got.body, { status: got.status, headers });
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        if (e.retryable && attempt < 2) continue;
        // The agent's tokens were already redeemed (step 2). Record what is owed so the operator can make it good.
        log({ ts: ts(), route: route.path, outcome: "owed", owed_cents: route.priceCents, reason: e.reason, detail: e.message });
        return c.json({ error: e.reason, detail: "the vendor purchase failed after your payment was redeemed; the gateway logged it as owed" }, 502);
      }
    }
  };
  for (const r of o.routes) app.get(r.path, serveRoute);

  return Object.assign(app, { providerPubkey: pubkey, facilitator });
}

/** A fetch handler that presents requests under `publicUrl`, so the x402 `resource.url` is the public one. */
export function withPublicUrl(app: { fetch: (req: Request) => Response | Promise<Response> }, publicUrl: string) {
  const base = new URL(publicUrl);
  return (req: Request) => {
    const u = new URL(req.url);
    u.protocol = base.protocol;
    u.host = base.host;
    return app.fetch(new Request(u, req));
  };
}
