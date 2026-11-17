// The live feed: derived from Coinbase's public API through an injected fetcher, so this stays offline.
import { describe, expect, it } from "vitest";
import { liveMarketSource, marketSourceFromEnv, mockMarketSource, type Fetcher } from "../src/data/liveMarket.js";
import { marketData } from "../src/data/marketData.js";

const NOW = Date.parse("2026-11-17T23:00:00Z");
const trade = (side: string, size: number, price: number, secAgo: number) =>
  ({ side, size: String(size), price: String(price), time: new Date(NOW - secAgo * 1000).toISOString() });

function fakeCoinbase(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {
    stats: { open: "70.00", last: "74.00", volume: "1000" },
    // Coinbase reports the maker side: "sell" means the taker bought.
    trades: [
      trade("sell", 500, 74, 10), trade("sell", 400, 74, 20), trade("buy", 300, 74, 30),
      ...Array.from({ length: 27 }, (_, i) => trade(i % 2 ? "buy" : "sell", 1, 74, 40 + i)),
    ],
    book: { bids: [["73.99", "10", 1], ["73.98", "5", 1]], asks: [["74.01", "7", 1], ["74.02", "3", 1]] },
    ...overrides,
  };
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const kind = url.includes("/stats") ? "stats" : url.includes("/trades") ? "trades" : "book";
    const body = bodies[kind];
    if (body instanceof Error) throw body;
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
  return { fetcher, calls };
}

describe("live market source", () => {
  it("derives whale flow from the largest recent trades, by taker side", async () => {
    const { fetcher, calls } = fakeCoinbase();
    const m = await liveMarketSource({ fetcher, now: () => NOW }).whaleFlow("sol");
    expect(calls[0]).toBe("https://api.exchange.coinbase.com/products/SOL-USD/stats");
    expect(m).toMatchObject({
      topic: "sol", feed: "whale-flow", price: 74, change_24h_pct: 5.7, volume_24h: 74_000, window: "recent",
      // Top 10% of 30 trades: the three big ones. Two taker buys (37,000 + 29,600), one taker sell (22,200).
      whale_buys: 2, whale_sells: 1, whale_netflow: 44_400, largest_trade_usd: 37_000,
      as_of: NOW / 1000, source: "live", venue: "coinbase",
    });
    expect(m.trades_window_s).toBe(56);
  });

  it("serves the top five book levels with the spread", async () => {
    const d = await liveMarketSource({ fetcher: fakeCoinbase().fetcher, now: () => NOW }).depth("sol");
    expect(d.bids[0]).toEqual({ price: 73.99, size: 10 });
    expect(d.asks[0]).toEqual({ price: 74.01, size: 7 });
    expect(d.spread_bps).toBe(2.7);
    expect(d.source).toBe("live");
  });

  it("turns whale imbalance and trend into a signal", async () => {
    const s = await liveMarketSource({ fetcher: fakeCoinbase().fetcher, now: () => NOW }).signals("sol");
    expect(s).toMatchObject({ feed: "signals", signal: "BUY", horizon: "1h", source: "live" });
    expect(s.confidence).toBeGreaterThan(0.5);
    expect(s.confidence).toBeLessThanOrEqual(0.9);
  });

  it("caches per token and route, and refetches after the cache expires", async () => {
    let t = NOW;
    const { fetcher, calls } = fakeCoinbase();
    const src = liveMarketSource({ fetcher, now: () => t, cacheMs: 20_000 });
    await src.whaleFlow("sol");
    await src.signals("sol");
    expect(calls).toHaveLength(2);
    t += 20_001;
    await src.whaleFlow("sol");
    expect(calls).toHaveLength(4);
  });

  it("falls back to the mock, labelled, on HTTP errors, network errors and unlisted tokens", async () => {
    const http = await liveMarketSource({ fetcher: fakeCoinbase({ stats: undefined }).fetcher }).whaleFlow("jup");
    expect(http).toMatchObject({ ...marketData("jup"), source: "mock" });
    expect(http.fallback_reason).toMatch(/HTTP 404/);
    const net = await liveMarketSource({ fetcher: fakeCoinbase({ book: new Error("ECONNRESET") }).fetcher }).depth("sol");
    expect(net).toMatchObject({ source: "mock", fallback_reason: "ECONNRESET" });
    const bad = await liveMarketSource({ fetcher: fakeCoinbase().fetcher }).whaleFlow("../x");
    expect(bad.source).toBe("mock");
  });

  it("does not cache failures", async () => {
    let fail = true;
    const { fetcher } = fakeCoinbase();
    const flaky: Fetcher = async (url, init) => { if (fail) throw new Error("down"); return fetcher(url, init); };
    const src = liveMarketSource({ fetcher: flaky, now: () => NOW });
    expect((await src.whaleFlow("sol")).source).toBe("mock");
    fail = false;
    expect((await src.whaleFlow("sol")).source).toBe("live");
  });

  it("MARKET_DATA=mock selects the deterministic feed", async () => {
    expect(marketSourceFromEnv({ MARKET_DATA: "mock" }).mode).toBe("mock");
    expect(marketSourceFromEnv({}).mode).toBe("live");
    expect(await mockMarketSource().whaleFlow("sol")).toEqual({ ...marketData("sol"), source: "mock" });
  });
});
