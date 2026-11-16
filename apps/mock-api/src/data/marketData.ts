// The demo provider's data: a token data feed in the style of the Solana DeFi feeds that sell per call over x402
// (whale flow, order-book depth). Fake and deterministic per topic (00 section 7.5).

export interface MarketData {
  topic: string;
  feed: "whale-flow";
  price: number;
  change_24h_pct: number;
  volume_24h: number;
  /** Net USD bought by whale wallets over `window` (negative: net selling). */
  whale_netflow: number;
  window: "1h";
  whale_buys: number;
  whale_sells: number;
  largest_trade_usd: number;
  as_of: number;
}

/** FNV-1a, so the numbers depend only on the topic string. */
function seed(s: string): () => number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^= h >>> 16) >>> 0) / 2 ** 32;
  };
}

const AS_OF = 1763166400;

/** Whale flow for a token. `as_of` is fixed so responses are reproducible. */
export function marketData(topic: string): MarketData {
  const r = seed(topic);
  const price = Math.round((10 + r() * 990) * 10) / 10;
  const change_24h_pct = Math.round((r() * 10 - 5) * 10) / 10;
  const volume_24h = Math.floor(1e6 + r() * 5e8);
  const whale_netflow = Math.floor(r() * 2e5 - 1e5);
  // Later draws only, so the fields above keep their earlier values.
  const trades = 6 + Math.floor(r() * 30);
  const buyShare = whale_netflow >= 0 ? 0.55 + r() * 0.3 : 0.15 + r() * 0.3;
  const whale_buys = Math.round(trades * buyShare);
  return {
    topic, feed: "whale-flow", price, change_24h_pct, volume_24h, whale_netflow, window: "1h",
    whale_buys, whale_sells: trades - whale_buys, largest_trade_usd: Math.floor(2e4 + r() * 4.8e5), as_of: AS_OF,
  };
}

export interface DepthLevel {
  price: number;
  size: number;
}

export interface DepthData {
  topic: string;
  feed: "depth";
  bids: DepthLevel[];
  asks: DepthLevel[];
  spread_bps: number;
  as_of: number;
}

/** Order-book depth around the whale-flow price: five levels a side. */
export function depthData(topic: string): DepthData {
  const r = seed(`${topic}/depth`);
  const base = marketData(topic).price;
  const level = (side: 1 | -1, i: number) => ({ price: Math.round((base + side * (i + 1) * 0.1) * 100) / 100, size: Math.floor(1 + r() * 500) });
  const bids = [0, 1, 2, 3, 4].map((i) => level(-1, i));
  const asks = [0, 1, 2, 3, 4].map((i) => level(1, i));
  const spread_bps = Math.round(((asks[0].price - bids[0].price) / base) * 10_000 * 10) / 10;
  return { topic, feed: "depth", bids, asks, spread_bps, as_of: AS_OF };
}
