// Live market data for the feed, derived from Coinbase Exchange's public, keyless REST API: price and 24h change from
// /stats, order-book depth from /book, and whale flow from the largest recent trades in /trades. Results are cached
// briefly so paid calls stay fast; any failure (network, timeout, unlisted token) falls back to the deterministic
// mock data and says so in the response.
import { depthData, marketData, signalsData, type DepthData, type MarketData, type SignalsData } from "./marketData.js";

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Where a response's numbers came from. Added to every feed response. */
export interface Provenance {
  source: "live" | "mock";
  /** Set when `source` is live. */
  venue?: "coinbase";
  /** Set when live data was wanted but the mock was served instead. */
  fallback_reason?: string;
}

export type WhaleFlow = MarketData & Provenance & { trades_window_s?: number };
export type Depth = DepthData & Provenance;
export type Signals = SignalsData & Provenance & { basis?: string };

export interface MarketSource {
  readonly mode: "live" | "mock";
  whaleFlow(topic: string): Promise<WhaleFlow>;
  depth(topic: string): Promise<Depth>;
  signals(topic: string): Promise<Signals>;
}

export interface LiveOptions {
  fetcher?: Fetcher;
  /** Cache lifetime per token and route. Default 20 s. */
  cacheMs?: number;
  /** Per request to Coinbase. Default 3 s. */
  timeoutMs?: number;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
  baseUrl?: string;
}

const MOCK: Provenance = { source: "mock" };

/** The deterministic feed (tests, crowd, offline runs). */
export function mockMarketSource(): MarketSource {
  return {
    mode: "mock",
    whaleFlow: async (t) => ({ ...marketData(t), ...MOCK }),
    depth: async (t) => ({ ...depthData(t), ...MOCK }),
    signals: async (t) => ({ ...signalsData(t), ...MOCK }),
  };
}

/** `MARKET_DATA=mock` selects the mock feed; anything else (or unset) the live one. */
export function marketSourceFromEnv(env: Record<string, string | undefined> = process.env, opts: LiveOptions = {}): MarketSource {
  return env.MARKET_DATA === "mock" ? mockMarketSource() : liveMarketSource(opts);
}

interface Trade { side: string; size: string; price: string; time: string }
interface Stats { open: string; last: string; volume: string }
interface Book { bids: [string, string, ...unknown[]][]; asks: [string, string, ...unknown[]][] }

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
/** Price rounding that keeps sub-cent tokens (BONK) readable. */
const roundPrice = (p: number) => (p >= 1 ? round(p, 2) : Number(p.toPrecision(4)));

export function liveMarketSource(o: LiveOptions = {}): MarketSource {
  const fetcher: Fetcher = o.fetcher ?? ((url, init) => fetch(url, init));
  const cacheMs = o.cacheMs ?? 20_000;
  const timeoutMs = o.timeoutMs ?? 3_000;
  const now = o.now ?? Date.now;
  const base = (o.baseUrl ?? "https://api.exchange.coinbase.com").replace(/\/$/, "");
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();

  /** One cached, de-duplicated request per key; failures are not cached. */
  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.value as Promise<T>;
    const value = load();
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: now(), value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  }

  async function get<T>(path: string): Promise<T> {
    const r = await fetcher(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "blindfold-feed" } });
    if (!r.ok) throw new Error(`coinbase ${path.split("?")[0]}: HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  const product = (topic: string) => {
    if (!/^[a-z0-9]{1,16}$/i.test(topic)) throw new Error(`not a token symbol: ${topic}`);
    return `${topic.toUpperCase()}-USD`;
  };
  const stats = (topic: string) => cached(`stats/${topic.toUpperCase()}`, () => get<Stats>(`/products/${product(topic)}/stats`));
  const trades = (topic: string) => cached(`trades/${topic.toUpperCase()}`, () => get<Trade[]>(`/products/${product(topic)}/trades?limit=1000`));
  const book = (topic: string) => cached(`book/${topic.toUpperCase()}`, () => get<Book>(`/products/${product(topic)}/book?level=2`));

  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

  async function liveWhaleFlow(topic: string): Promise<WhaleFlow> {
    const [s, ts] = await Promise.all([stats(topic), trades(topic)]);
    const price = Number(s.last);
    const open = Number(s.open);
    const volumeUsd = Number(s.volume) * price;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(open) || open <= 0 ||
        !Number.isFinite(volumeUsd) || volumeUsd < 0 || !Array.isArray(ts) || ts.length === 0) {
      throw new Error("coinbase: incomplete market data");
    }
    // Coinbase reports the maker's side; the taker (the aggressor) did the opposite.
    const fills = ts.map((t) => {
      const usd = Number(t.size) * Number(t.price);
      if (!Number.isFinite(usd) || usd <= 0 || (t.side !== "buy" && t.side !== "sell")) throw new Error("coinbase: invalid trade");
      return { usd, takerBuy: t.side === "sell", at: Date.parse(t.time) };
    });
    // Whales: the largest 10% of recent trades by notional.
    const cutoff = [...fills].sort((a, b) => b.usd - a.usd)[Math.max(0, Math.floor(fills.length * 0.1) - 1)].usd;
    const whales = fills.filter((f) => f.usd >= cutoff);
    const buys = whales.filter((f) => f.takerBuy);
    const sum = (xs: typeof fills) => xs.reduce((t, f) => t + f.usd, 0);
    const times = fills.map((f) => f.at).filter(Number.isFinite);
    return {
      topic, feed: "whale-flow", price: roundPrice(price), change_24h_pct: round(((price - open) / open) * 100, 1),
      volume_24h: Math.floor(volumeUsd), whale_netflow: Math.round(sum(buys) - sum(whales.filter((f) => !f.takerBuy))),
      window: "recent", whale_buys: buys.length, whale_sells: whales.length - buys.length,
      largest_trade_usd: Math.floor(Math.max(...fills.map((f) => f.usd))), as_of: Math.floor(now() / 1000),
      source: "live", venue: "coinbase", trades_window_s: times.length ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : 0,
    };
  }

  async function liveDepth(topic: string): Promise<Depth> {
    const b = await book(topic);
    const side = (xs: Book["bids"]) => xs.slice(0, 5).map(([p, q]) => {
      const price = Number(p), size = Number(q);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) throw new Error("coinbase: invalid book level");
      return { price: roundPrice(price), size: round(size, 4) };
    });
    const bids = side(b.bids ?? []);
    const asks = side(b.asks ?? []);
    if (!bids.length || !asks.length) throw new Error("coinbase: empty order book");
    const mid = (Number(b.bids[0][0]) + Number(b.asks[0][0])) / 2;
    return {
      topic, feed: "depth", bids, asks, spread_bps: round(((Number(b.asks[0][0]) - Number(b.bids[0][0])) / mid) * 10_000, 1),
      as_of: Math.floor(now() / 1000), source: "live", venue: "coinbase",
    };
  }

  async function liveSignals(topic: string): Promise<Signals> {
    const m = await liveWhaleFlow(topic);
    // Whale imbalance in [-1, 1], nudged by the day's trend.
    const gross = m.whale_buys + m.whale_sells;
    const imbalance = gross ? (m.whale_buys - m.whale_sells) / gross : 0;
    const score = imbalance + Math.max(-0.3, Math.min(0.3, m.change_24h_pct / 10));
    const signal = score > 0.25 ? "BUY" : score < -0.25 ? "SELL" : "HOLD";
    return {
      topic, feed: "signals", signal, confidence: round(Math.min(0.9, 0.5 + Math.abs(score) * 0.4), 2), horizon: "1h",
      as_of: m.as_of, source: "live", venue: "coinbase",
      basis: `whale trades ${m.whale_buys} buy / ${m.whale_sells} sell, 24h ${m.change_24h_pct}%`,
    };
  }

  const withFallback = <T extends Provenance, M>(live: () => Promise<T>, mock: () => M): Promise<T> =>
    live().catch((e) => ({ ...mock(), source: "mock", fallback_reason: reason(e) }) as unknown as T);

  return {
    mode: "live",
    whaleFlow: (t) => withFallback(() => liveWhaleFlow(t), () => marketData(t)),
    depth: (t) => withFallback(() => liveDepth(t), () => depthData(t)),
    signals: (t) => withFallback(() => liveSignals(t), () => signalsData(t)),
  };
}
