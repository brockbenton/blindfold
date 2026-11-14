import { serve } from "@hono/node-server";
import { getEncodedToken, type Proof } from "@cashu/cashu-ts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { createTestKeyset, fakeRedeem, issueLockedProofs, makeProviderKey } from "@blindfold/testkit";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, signerSet, type WireProof } from "@blindfold/protocol";
import { createApp, type AppOptions } from "../../src/app.js";
import { MintUnavailableError, RedeemError, type RedeemClient } from "../../src/x402/redeemClient.js";
import { StaticKeysetSource } from "../../src/x402/keysets.js";

export const MINT_URL = "http://localhost:3338";
export const keyset = createTestKeyset(7);
export const provider = makeProviderKey();
export const other = makeProviderKey();
export const third = makeProviderKey();

// Blind issuance is slow in pure JS: issue each shape once per process. Each test gets a fresh spent set.
const pool = new Map<string, Proof[]>();
export function proofs(allowlist: string[], amounts: number[]): Proof[] {
  const k = `${allowlist.join()}|${amounts.join()}`;
  if (!pool.has(k)) pool.set(k, issueLockedProofs({ keyset, allowlist, amounts }));
  return pool.get(k)!;
}
export const tokenOf = (ps: Proof[], o: { mint?: string; unit?: string } = {}) =>
  getEncodedToken({ mint: o.mint ?? MINT_URL, unit: o.unit ?? "usd", proofs: ps });

export type Fail = null | "timeout" | "5xx" | number;

export async function startProvider(over: Partial<AppOptions> = {}) {
  const mint = fakeRedeem(keyset, [provider.pubkey, other.pubkey]);
  const seen: WireProof[][] = [];
  const events: string[] = [];
  const state = { fail: null as Fail };
  const redeem: RedeemClient = {
    async redeem(ps) {
      seen.push(ps);
      events.push("redeem");
      if (state.fail === "timeout") throw new MintUnavailableError("timeout");
      if (state.fail === "5xx") throw new MintUnavailableError("HTTP 503");
      if (typeof state.fail === "number") throw new RedeemError(state.fail, "forced");
      const r = mint.redeem(ps);
      if (!r.ok) throw new RedeemError(r.code, r.detail);
      return { provider_id: r.provider_id, amount: r.amount, redemption_id: r.redemption_id };
    },
  };
  const logs: Record<string, unknown>[] = [];
  const app = createApp({
    mintUrl: MINT_URL, providerSecretKey: provider.sk, priceCents: 5, redeem, keysets: new StaticKeysetSource([keyset.id]),
    log: (e) => logs.push(e),
    dataHandler: (c, topic) => { events.push("handler"); return c.json({ topic, ok: true }); },
    ...over,
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => setTimeout(r, 50));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    app, url, mint, seen, events, logs, state,
    reasons: () => logs.map((l) => String(l.outcome)).filter((o) => o.startsWith("rejected:")).map((o) => o.slice(9)),
    stop: () => new Promise<void>((r) => { (server as any).closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** Decode the 402 challenge for a URL. */
export async function challenge(url: string) {
  const res = await fetch(url);
  const h = res.headers.get("PAYMENT-REQUIRED");
  return { res, pr: h ? JSON.parse(Buffer.from(h, "base64").toString()) : null };
}

/** Hand-built PAYMENT-SIGNATURE with `accepted` copied from the 402. */
export function forge(pr: any, token: string): string {
  const accepted = pr.accepts.find((a: any) => a.scheme === "cashu");
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted, payload: { token } })).toString("base64");
}

/** A minimal paying client (not the wallet SDK): picks an exact subset by brute force, as in the spike. */
export function payClient(wallet: { proofs: Proof[] }, capCents = 10) {
  let lastHeader: string | null = null;
  const scheme = {
    scheme: "cashu",
    async createPaymentPayload(x402Version: number, req: any) {
      const cents = Number(BigInt(req.amount) / 10_000n);
      const pk = req.extra.nut10.d as string;
      const el = wallet.proofs.filter((p) => signerSet(p.secret).includes(pk));
      for (let mask = 1; mask < 1 << el.length; mask++) {
        const pick = el.filter((_, i) => mask & (1 << i));
        if (pick.reduce((s, p) => s + p.amount.toNumber(), 0) === cents) {
          wallet.proofs = wallet.proofs.filter((p) => !pick.includes(p));
          return { x402Version, payload: { token: tokenOf(pick) } };
        }
      }
      throw new Error("no exact subset");
    },
  };
  const client = new x402Client().register(SOLANA_DEVNET_CAIP2, scheme as any).setSpendControls({
    allowedAssets: [{ network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, maxAmountPerPayment: String(capCents * 10_000) }],
  });
  const spy: typeof fetch = async (input, init) => {
    const h = new Request(input as Request, init).headers.get("PAYMENT-SIGNATURE");
    if (h) lastHeader = h;
    return fetch(input, init);
  };
  return { fetch: wrapFetchWithPayment(spy, client), header: () => lastHeader, balance: () => wallet.proofs.reduce((s, p) => s + p.amount.toNumber(), 0) };
}
