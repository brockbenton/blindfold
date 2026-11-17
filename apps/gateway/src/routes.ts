// The gateway's route map: which upstream x402 endpoint each gateway path resells, and at what price.

export interface GatewayRoute {
  /** Gateway path with `:name` parameters, e.g. `/v1/data/:topic`. */
  path: string;
  /** Upstream URL with the same `:name` parameters, e.g. `https://vendor.example/v1/data/:topic`. */
  upstream: string;
  /** What the agent pays the gateway, in whole cents (Blindfold tokens are cents). */
  priceCents: number;
  /** The most the gateway will pay upstream for one call, in cents. Must not exceed `priceCents`. */
  maxUpstreamCents: number;
  description: string;
  /** Query parameters forwarded upstream. Everything else is dropped. Default: none. */
  query?: string[];
}

const PARAM = /:([a-z][a-zA-Z0-9]{0,31})/g;
/** Parameter values that can reach the upstream URL: no slashes, dots or encodings to smuggle a different path. */
const VALUE = /^[A-Za-z0-9_-]{1,64}$/;

const paramsOf = (s: string) => [...s.matchAll(PARAM)].map((m) => m[1]).sort();

/** Validates a route map (JSON array). Throws with the offending route on any problem. */
export function parseRoutes(input: unknown): GatewayRoute[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("routes must be a non-empty array");
  const seen = new Set<string>();
  return input.map((r: Partial<GatewayRoute>, i) => {
    const where = `route ${i} (${r?.path ?? "?"})`;
    if (typeof r?.path !== "string" || !r.path.startsWith("/")) throw new Error(`${where}: path must start with /`);
    if (seen.has(r.path)) throw new Error(`${where}: duplicate path`);
    seen.add(r.path);
    if (typeof r.upstream !== "string") throw new Error(`${where}: upstream URL missing`);
    const u = new URL(r.upstream.replace(PARAM, "x"));
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${where}: upstream must be http(s)`);
    if (paramsOf(r.path).join() !== paramsOf(r.upstream).join()) throw new Error(`${where}: path and upstream must use the same :parameters`);
    for (const k of ["priceCents", "maxUpstreamCents"] as const) {
      if (!Number.isInteger(r[k]) || (r[k] as number) < 1) throw new Error(`${where}: ${k} must be a positive integer`);
    }
    if (r.maxUpstreamCents! > r.priceCents!) throw new Error(`${where}: priceCents must be at least maxUpstreamCents, or the gateway pays out of pocket`);
    if (r.query !== undefined && (!Array.isArray(r.query) || r.query.some((q) => typeof q !== "string"))) throw new Error(`${where}: query must be a list of names`);
    return {
      path: r.path, upstream: r.upstream, priceCents: r.priceCents!, maxUpstreamCents: r.maxUpstreamCents!,
      description: typeof r.description === "string" ? r.description : `resold from ${u.host}`, query: r.query ?? [],
    };
  });
}

/**
 * The devnet stand-in: resell apps/mock-api's three feeds (with its `exact` baseline on) at the same prices, so
 * every gateway call makes one real `exact` payment on devnet.
 */
export function standInRoutes(upstreamBase: string): GatewayRoute[] {
  const base = upstreamBase.replace(/\/+$/, "");
  return parseRoutes([
    { path: "/v1/data/:topic", upstream: `${base}/v1/data/:topic`, priceCents: 5, maxUpstreamCents: 5, description: "whale flow, resold" },
    { path: "/v1/data/:topic/depth", upstream: `${base}/v1/data/:topic/depth`, priceCents: 10, maxUpstreamCents: 10, description: "order-book depth, resold" },
    { path: "/v1/data/:topic/signals", upstream: `${base}/v1/data/:topic/signals`, priceCents: 25, maxUpstreamCents: 25, description: "trade signal, resold" },
  ]);
}

/** Builds the upstream URL from validated parameters and only the allowlisted query parameters. */
export function upstreamUrl(route: GatewayRoute, params: Record<string, string>, query: URLSearchParams): string {
  const path = route.upstream.replace(PARAM, (_, name: string) => {
    const v = params[name];
    if (v === undefined || !VALUE.test(v)) throw new BadParamError(name);
    return encodeURIComponent(v);
  });
  const u = new URL(path);
  for (const q of route.query ?? []) {
    const v = query.get(q);
    if (v !== null) u.searchParams.set(q, v);
  }
  return u.toString();
}

export class BadParamError extends Error {
  constructor(readonly param: string) {
    super(`invalid value for :${param}`);
  }
}
