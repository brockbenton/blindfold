import { serve } from "@hono/node-server";
import { loadMockApiEnv } from "@blindfold/protocol";
import { createApp, withPublicUrl } from "./app.js";

const env = loadMockApiEnv();
const app = createApp({
  mintUrl: env.MINT_URL, providerSecretKey: env.PROVIDER_SECRET_KEY, priceCents: env.PRICE_CENTS,
  usdcMint: env.USDC_MINT, providerId: env.PROVIDER_ID,
});
serve({ fetch: withPublicUrl(app, env.PUBLIC_URL), port: env.PORT }, () => {
  console.log(JSON.stringify({ msg: "mock-api listening", port: env.PORT, pubkey: app.providerPubkey, price_cents: env.PRICE_CENTS }));
});
