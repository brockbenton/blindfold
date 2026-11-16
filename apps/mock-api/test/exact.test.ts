// The x402 `exact` baseline (00 section 7.1, add-on 1): a second accepts entry on the paid routes, routing to the
// exact facilitator, and RPC rate-limit retries.
import { afterEach, describe, expect, it } from "vitest";
import type { FacilitatorClient } from "@x402/core/http";
import type { FacilitatorSvmSigner } from "@x402/svm";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT } from "@blindfold/protocol";
import { retryRateLimited } from "../src/x402/exactBaseline.js";
import { challenge, startProvider } from "./helpers/world.js";

const PAY_TO = "ELPmNrhcyY3tMYjZb9HuFRBiNSim4tcXjstm8E1F5bzd";
const FEE_PAYER = "88v4wTeaFJmWxThVSwj476ZbsR2BaFteR3aWGsvfzpXS";

function fakeExactFacilitator(settleOk = true) {
  const calls: string[] = [];
  const f: FacilitatorClient = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET_CAIP2, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} }),
    verify: async () => { calls.push("verify"); return { isValid: true, payer: "payer-wallet" }; },
    settle: async () => {
      calls.push("settle");
      return settleOk
        ? { success: true, transaction: "onchain-sig", network: SOLANA_DEVNET_CAIP2, payer: "payer-wallet" }
        : { success: false, errorReason: "transaction_failed", transaction: "", network: SOLANA_DEVNET_CAIP2 };
    },
  };
  return { f, calls };
}
const pay = (pr: any) =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts.find((a: any) => a.scheme === "exact"), payload: { transaction: "base64-tx" } })).toString("base64");

let p: Awaited<ReturnType<typeof startProvider>>;
afterEach(async () => { await p?.stop(); });

describe("exact baseline routes", () => {
  it("are offered only when enabled", async () => {
    p = await startProvider();
    expect((await challenge(`${p.url}/v1/data/sol`)).pr.accepts.map((a: any) => a.scheme)).toEqual(["cashu"]);
  });

  it("add a standard exact entry after cashu, paid to the provider wallet, fee payer from the facilitator", async () => {
    p = await startProvider({ exact: { payTo: PAY_TO, facilitator: fakeExactFacilitator().f } });
    for (const [path, amount] of [["/v1/data/sol", "50000"], ["/v1/data/sol/depth", "100000"]]) {
      const { res, pr } = await challenge(p.url + path);
      expect(res.status).toBe(402);
      expect(pr.accepts.map((a: any) => a.scheme)).toEqual(["cashu", "exact"]);
      expect(pr.accepts[1]).toMatchObject({ scheme: "exact", network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, amount, payTo: PAY_TO, extra: { feePayer: FEE_PAYER } });
    }
  });

  it("serves data after the exact facilitator verifies and settles; the response names the onchain transaction", async () => {
    const fx = fakeExactFacilitator();
    p = await startProvider({ exact: { payTo: PAY_TO, facilitator: fx.f } });
    const { pr } = await challenge(`${p.url}/v1/data/sol`);
    const res = await fetch(`${p.url}/v1/data/sol`, { headers: { "PAYMENT-SIGNATURE": pay(pr) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topic: "sol", ok: true });
    expect(fx.calls).toEqual(["verify", "settle"]);
    const settled = JSON.parse(Buffer.from(res.headers.get("PAYMENT-RESPONSE")!, "base64").toString());
    expect(settled).toMatchObject({ success: true, transaction: "onchain-sig" });
    expect(p.seen).toHaveLength(0); // the Blindfold mint is not involved
  });

  it("returns 402, not data, when exact settlement fails", async () => {
    const fx = fakeExactFacilitator(false);
    p = await startProvider({ exact: { payTo: PAY_TO, facilitator: fx.f } });
    const { pr } = await challenge(`${p.url}/v1/data/sol`);
    const res = await fetch(`${p.url}/v1/data/sol`, { headers: { "PAYMENT-SIGNATURE": pay(pr) } });
    expect(res.status).toBe(402);
    expect(await res.text()).not.toContain("price");
  });
});

describe("retryRateLimited", () => {
  const rateLimited = () => Object.assign(new Error("HTTP error (429)"), { context: { statusCode: 429, headers: new Headers() } });
  const signer = (impl: () => Promise<string>) => ({ getAddresses: () => [], sendTransaction: impl }) as unknown as FacilitatorSvmSigner;

  it("retries a 429 and returns the eventual result", async () => {
    let n = 0;
    const s = retryRateLimited(signer(async () => { if (++n < 3) throw rateLimited(); return "sig"; }));
    expect(await s.sendTransaction("tx", "net")).toBe("sig");
    expect(n).toBe(3);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    const s = retryRateLimited(signer(async () => { n++; throw new Error("simulation failed"); }));
    await expect(s.sendTransaction("tx", "net")).rejects.toThrow("simulation failed");
    expect(n).toBe(1);
  });
});
