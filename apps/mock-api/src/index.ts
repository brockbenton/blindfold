import { serve } from "@hono/node-server";
import { loadMockApiEnv } from "@blindfold/protocol";
import { createApp, withPublicUrl } from "./app.js";
import { marketSourceFromEnv } from "./data/liveMarket.js";
import { exactFacilitator, readKeypairFile } from "./x402/exactBaseline.js";

const env = loadMockApiEnv();
// Optional baseline: EXACT_PAY_TO (provider wallet) and EXACT_FACILITATOR_KEYPAIR (fee payer keypair file) enable /exact routes.
const exactPayTo = process.env.EXACT_PAY_TO;
const exactKey = process.env.EXACT_FACILITATOR_KEYPAIR;
if (!!exactPayTo !== !!exactKey) throw new Error("set both EXACT_PAY_TO and EXACT_FACILITATOR_KEYPAIR, or neither");
const exact = exactPayTo && exactKey
  ? { payTo: exactPayTo, facilitator: await exactFacilitator({ keypair: readKeypairFile(exactKey), rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com" }) }
  : undefined;
const app = createApp({
  mintUrl: env.MINT_URL, providerSecretKey: env.PROVIDER_SECRET_KEY, priceCents: env.PRICE_CENTS,
  usdcMint: env.USDC_MINT, providerId: env.PROVIDER_ID, exact,
  // Live Coinbase market data unless MARKET_DATA=mock; falls back to the mock per request on any failure.
  market: marketSourceFromEnv(),
});
serve({ fetch: withPublicUrl(app, env.PUBLIC_URL), port: env.PORT }, () => {
  console.log(JSON.stringify({ msg: "mock-api listening", port: env.PORT, pubkey: app.providerPubkey, price_cents: env.PRICE_CENTS, market_data: app.market.mode, exact: exact ? { pay_to: exact.payTo, fee_payer: exact.facilitator.feePayer } : null }));
});
