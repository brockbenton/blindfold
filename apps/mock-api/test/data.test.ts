// The demo feed's data: deterministic per token and internally consistent.
import { describe, expect, it } from "vitest";
import { depthData, marketData, signalsData } from "../src/data/marketData.js";

describe("token data feed", () => {
  it("is deterministic and keeps the 00 section 7.5 fields", () => {
    expect(marketData("sol")).toEqual(marketData("sol"));
    expect(marketData("sol")).toMatchObject({ topic: "sol", feed: "whale-flow", price: 114.1, change_24h_pct: 0.9, whale_netflow: 14151, as_of: 1763166400 });
  });

  it("splits whale trades in the direction of the netflow", () => {
    for (const t of ["sol", "btc", "eth", "jup", "bonk"]) {
      const m = marketData(t);
      expect(m.whale_buys + m.whale_sells).toBeGreaterThanOrEqual(6);
      if (m.whale_netflow > 0) expect(m.whale_buys).toBeGreaterThan(m.whale_sells);
      if (m.whale_netflow < 0) expect(m.whale_sells).toBeGreaterThan(m.whale_buys);
    }
  });

  it("builds depth around the whale-flow price, bids below asks", () => {
    const d = depthData("sol");
    expect(d.bids).toHaveLength(5);
    expect(d.bids[0].price).toBeLessThan(marketData("sol").price);
    expect(d.asks[0].price).toBeGreaterThan(marketData("sol").price);
    expect(d.spread_bps).toBeGreaterThan(0);
  });

  it("derives the premium signal from whale flow, deterministically", () => {
    for (const t of ["sol", "btc", "eth", "bonk"]) {
      const s = signalsData(t);
      const flow = marketData(t).whale_netflow;
      expect(s.signal).toBe(flow > 20_000 ? "BUY" : flow < -20_000 ? "SELL" : "HOLD");
      expect(s.confidence).toBeGreaterThanOrEqual(0.55);
      expect(s.confidence).toBeLessThanOrEqual(0.9);
      expect(signalsData(t)).toEqual(s);
    }
  });
});
