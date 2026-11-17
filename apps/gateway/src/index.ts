// Blindfold gateway: resells upstream x402 `exact` endpoints to agents paying with Blindfold tokens.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT } from "@blindfold/protocol";
import { createGateway, withPublicUrl } from "./app.js";
import { parseRoutes, standInRoutes } from "./routes.js";
import { UpstreamClient } from "./upstream.js";
import { loadOrCreateKeypair, walletPayFetch } from "./wallet.js";

const env = process.env;
const port = Number(env.PORT ?? 4100);
// Key files default to the repository's .keys/, wherever the process starts (`pnpm gateway` runs in apps/gateway).
const KEYS = fileURLToPath(new URL("../../../.keys/", import.meta.url));
const secretFile = env.GATEWAY_SECRET_FILE ?? join(KEYS, "gateway-secret.hex");
const providerSecretKey = env.GATEWAY_SECRET_KEY ?? (existsSync(secretFile) ? readFileSync(secretFile, "utf8").trim() : "");
if (!providerSecretKey) throw new Error(`no gateway provider key: set GATEWAY_SECRET_KEY or run \`pnpm gateway:setup\` to create ${secretFile}`);
const usdcMint = env.USDC_MINT ?? USDC_DEVNET_MINT;
const walletFile = env.GATEWAY_WALLET ?? join(KEYS, "gateway-wallet.json");
const { bytes, created } = loadOrCreateKeypair(walletFile, true);
const wallet = await walletPayFetch({ keypair: bytes, rpcUrl: env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", network: SOLANA_DEVNET_CAIP2, asset: usdcMint });
const routes = env.GATEWAY_ROUTES ? parseRoutes(JSON.parse(readFileSync(env.GATEWAY_ROUTES, "utf8"))) : standInRoutes(env.UPSTREAM_URL ?? "http://localhost:4000");

const app = createGateway({
  mintUrl: env.MINT_URL ?? "http://localhost:3338", providerSecretKey, routes, usdcMint,
  providerId: env.PROVIDER_ID === undefined ? undefined : Number(env.PROVIDER_ID),
  upstream: new UpstreamClient({ payFetch: wallet.payFetch, network: SOLANA_DEVNET_CAIP2, asset: usdcMint }),
});
serve({ fetch: withPublicUrl(app, env.PUBLIC_URL ?? `http://localhost:${port}`), port }, () => {
  console.log(JSON.stringify({
    msg: "gateway listening", port, pubkey: app.providerPubkey, wallet: wallet.address,
    routes: routes.map((r) => `${r.path} -> ${r.upstream} (${r.priceCents}c, upstream max ${r.maxUpstreamCents}c)`),
    ...(created ? { note: `created ${walletFile}: fund it with devnet USDC (faucet.circle.com) before serving paid calls` } : {}),
  }));
});
