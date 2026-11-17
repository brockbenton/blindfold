import { afterEach, describe, expect, it } from "vitest";
import { UPSTREAM_HEADERS } from "../src/upstream.js";
import { agent, proofs, startGateway } from "./helpers.js";

let g: Awaited<ReturnType<typeof startGateway>>;
afterEach(() => g?.stop());

describe("gateway pay-through", () => {
  it("quotes, redeems the agent's tokens, buys upstream and serves the vendor's response", async () => {
    g = await startGateway();
    const a = agent({ proofs: proofs([1, 4]) });
    const res = await a.fetch(`${g.url}/v1/data/sol`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vendor: true, url: "/v1/data/sol" });
    expect(res.headers.get("x-upstream-payment")).toBe("VendorTxSig");
    expect(a.balance()).toBe(0);
    // Quoted once for the challenge, once before the paid retry; the redeem comes before the purchase.
    expect(g.vendor.events).toEqual(["quote", "quote", "redeem", "buy"]);
    expect(g.vendor.requests.find((r) => r.paid)?.maxBase).toBe(50_000n);
    expect(g.logs.some((l) => l.outcome === "upstream_bought" && l.transaction === "VendorTxSig")).toBe(true);
  });

  it("refuses before payment when the vendor charges more than the route allows", async () => {
    g = await startGateway();
    g.vendor.state.priceBase = 60_000n;
    const a = agent({ proofs: proofs([1, 4]) });
    const res = await a.fetch(`${g.url}/v1/data/sol`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_price_too_high" });
    expect(a.balance()).toBe(5);
    expect(g.vendor.events).not.toContain("redeem");
    expect(g.vendor.events).not.toContain("buy");
  });

  it("refuses before payment when the vendor is unreachable", async () => {
    g = await startGateway();
    g.vendor.state.down = true;
    const a = agent({ proofs: proofs([1, 4]) });
    const res = await a.fetch(`${g.url}/v1/data/sol`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unavailable" });
    expect(a.balance()).toBe(5);
    expect(g.vendor.events).not.toContain("redeem");
  });

  it("retries a transient purchase failure once", async () => {
    g = await startGateway();
    g.vendor.state.buyFailures = ["throw"];
    const res = await agent({ proofs: proofs([1, 4]) }).fetch(`${g.url}/v1/data/sol`);
    expect(res.status).toBe(200);
    expect(g.vendor.events.filter((e) => e === "buy")).toHaveLength(2);
  });

  it("logs the call as owed when the purchase fails after the redeem", async () => {
    g = await startGateway();
    g.vendor.state.buyFailures = ["402"];
    const a = agent({ proofs: proofs([1, 4]) });
    const res = await a.fetch(`${g.url}/v1/data/sol`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("upstream_payment_failed");
    expect(a.balance()).toBe(0);
    expect(g.vendor.events).toEqual(["quote", "quote", "redeem", "buy"]);
    expect(g.logs).toContainEqual(expect.objectContaining({ outcome: "owed", owed_cents: 5, reason: "upstream_payment_failed" }));
  });

  it("charges the route's price, not the vendor's", async () => {
    g = await startGateway();
    const a = agent({ proofs: proofs([8, 2, 4, 1]) });
    const res = await a.fetch(`${g.url}/v1/data/sol/depth`);
    expect(res.status).toBe(200);
    expect(a.balance()).toBe(5);
    expect(g.vendor.requests.find((r) => r.paid)?.maxBase).toBe(100_000n);
  });
});

describe("what reaches the vendor", () => {
  it("only the gateway's own headers and the mapped path: no agent headers, IPs or query", async () => {
    g = await startGateway();
    const a = agent({ proofs: proofs([1, 4]) });
    const res = await a.fetch(`${g.url}/v1/data/sol?wallet=agent-7&debug=1`, {
      headers: { authorization: "Bearer agent-secret", cookie: "sid=abc", "x-forwarded-for": "203.0.113.9", "user-agent": "agent/1.0", "x-agent-id": "7" },
    });
    expect(res.status).toBe(200);
    expect(g.vendor.requests.length).toBeGreaterThan(0);
    for (const r of g.vendor.requests) {
      expect(r.url).toBe("http://vendor.test/v1/data/sol");
      expect(r.headers).toEqual(UPSTREAM_HEADERS);
    }
  });

  it("rejects parameter values that could rewrite the upstream path", async () => {
    g = await startGateway();
    const res = await fetch(`${g.url}/v1/data/sol%2E%2E`);
    expect(res.status).toBe(400);
    expect(g.vendor.events).toEqual([]);
  });
});
