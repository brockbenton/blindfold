import { serve } from "@hono/node-server";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { createTestKeyset, fakeRedeem, issueLockedProofs, makeProviderKey } from "@blindfold/testkit";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, signerSet } from "@blindfold/protocol";
import { RedeemError, type RedeemClient } from "mock-api/x402/redeemClient";
import { StaticKeysetSource } from "mock-api/x402/keysets";
import { createGateway } from "../src/app.js";
import { standInRoutes, type GatewayRoute } from "../src/routes.js";
import { UpstreamClient, type PayFetchFactory } from "../src/upstream.js";

export const MINT_URL = "http://localhost:3338";
export const VENDOR = "http://vendor.test";
const keyset = createTestKeyset(11);
export const gatewayKey = makeProviderKey();

const pool = new Map<string, Proof[]>();
export function proofs(amounts: number[]): Proof[] {
  const k = amounts.join();
  if (!pool.has(k)) pool.set(k, issueLockedProofs({ keyset, allowlist: [gatewayKey.pubkey], amounts }));
  return [...pool.get(k)!];
}

/** A fake x402 `exact` vendor: answers unpaid requests with a 402 quote, and paid ones (through `payFetch`) with data. */
export function fakeVendor() {
  const state = {
    priceBase: 50_000n,
    down: false,
    /** Failures for the next paid calls, consumed in order: "throw" (network, retryable), "402" or "500". */
    buyFailures: [] as ("throw" | "402" | "500")[],
  };
  const requests: { url: string; headers: Record<string, string>; paid: boolean; maxBase?: bigint }[] = [];
  const events: string[] = [];
  const record = (input: string | URL | Request, init: RequestInit | undefined, paid: boolean, maxBase?: bigint) => {
    const req = new Request(input as string, init);
    requests.push({ url: req.url, headers: Object.fromEntries(req.headers), paid, maxBase });
  };
  const quoteFetch: typeof fetch = async (input, init) => {
    record(input, init, false);
    events.push("quote");
    if (state.down) throw new TypeError("fetch failed");
    const pr = { x402Version: 2, accepts: [{ scheme: "exact", network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, amount: String(state.priceBase), payTo: "VendorPayTo1111111111111111111111111111111" }] };
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  };
  const payFetch: PayFetchFactory = (maxBase) => async (input, init) => {
    record(input, init, true, maxBase);
    events.push("buy");
    const f = state.buyFailures.shift();
    if (f === "throw") throw new TypeError("fetch failed");
    if (f === "402") return new Response("{}", { status: 402 });
    if (f === "500") return new Response("oops", { status: 500 });
    if (state.priceBase > maxBase) throw new Error("amount exceeds maxAmountPerPayment");
    const receipt = Buffer.from(JSON.stringify({ success: true, transaction: "VendorTxSig" })).toString("base64");
    return new Response(JSON.stringify({ vendor: true, url: new URL(input as string).pathname }), {
      status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": receipt },
    });
  };
  return { state, requests, events, quoteFetch, payFetch };
}

export async function startGateway(o: { routes?: GatewayRoute[] } = {}) {
  const vendor = fakeVendor();
  const mint = fakeRedeem(keyset, [gatewayKey.pubkey]);
  const redeem: RedeemClient = {
    async redeem(ps) {
      vendor.events.push("redeem");
      const r = mint.redeem(ps);
      if (!r.ok) throw new RedeemError(r.code, r.detail);
      return { provider_id: r.provider_id, amount: r.amount, redemption_id: r.redemption_id };
    },
  };
  const logs: Record<string, unknown>[] = [];
  const app = createGateway({
    mintUrl: MINT_URL, providerSecretKey: gatewayKey.sk, routes: o.routes ?? standInRoutes(VENDOR),
    redeem, keysets: new StaticKeysetSource([keyset.id]), log: (e) => logs.push(e),
    upstream: new UpstreamClient({ payFetch: vendor.payFetch, fetch: vendor.quoteFetch, network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, quoteTtlMs: 0 }),
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 50));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url, vendor, logs,
    stop: () => new Promise<void>((r) => { (server as any).closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A minimal paying agent for the `blindfold` scheme: pays the exact amount from its proofs. */
export function agent(wallet: { proofs: Proof[] }, capCents = 30) {
  const scheme = {
    scheme: "blindfold",
    async createPaymentPayload(x402Version: number, req: any) {
      const cents = Number(BigInt(req.amount) / 10_000n);
      const pk = req.extra.nut10.d as string;
      const el = wallet.proofs.filter((p) => signerSet(p.secret).includes(pk));
      for (let mask = 1; mask < 1 << el.length; mask++) {
        const pick = el.filter((_, i) => mask & (1 << i));
        if (pick.reduce((s, p) => s + p.amount.toNumber(), 0) === cents) {
          wallet.proofs = wallet.proofs.filter((p) => !pick.includes(p));
          return { x402Version, payload: { token: getEncodedToken({ mint: MINT_URL, unit: "usd", proofs: pick }) } };
        }
      }
      throw new Error("no exact subset");
    },
  };
  const client = new x402Client().register(SOLANA_DEVNET_CAIP2, scheme as any).setSpendControls({
    allowedAssets: [{ network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, maxAmountPerPayment: String(capCents * 10_000) }],
  });
  return { fetch: wrapFetchWithPayment(fetch, client), balance: () => wallet.proofs.reduce((s, p) => s + p.amount.toNumber(), 0) };
}
