export interface MarketData {
  topic: string;
  price: number;
  change_24h_pct: number;
  volume_24h: number;
  whale_netflow: number;
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

/** Fake, deterministic per topic (00 section 7.5). `as_of` is fixed so responses are reproducible. */
export function marketData(topic: string): MarketData {
  const r = seed(topic);
  return {
    topic,
    price: Math.round((10 + r() * 990) * 10) / 10,
    change_24h_pct: Math.round((r() * 10 - 5) * 10) / 10,
    volume_24h: Math.floor(1e6 + r() * 5e8),
    whale_netflow: Math.floor(r() * 2e5 - 1e5),
    as_of: 1763166400,
  };
}

export function depthData(topic: string) {
  const r = seed(`${topic}/depth`);
  const base = marketData(topic).price;
  const level = (side: 1 | -1, i: number) => ({ price: Math.round((base + side * (i + 1) * 0.1) * 100) / 100, size: Math.floor(1 + r() * 500) });
  return { topic, bids: [0, 1, 2, 3, 4].map((i) => level(-1, i)), asks: [0, 1, 2, 3, 4].map((i) => level(1, i)), as_of: 1763166400 };
}
