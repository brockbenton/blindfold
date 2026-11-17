import { describe, expect, it } from "vitest";
import { BadParamError, parseRoutes, standInRoutes, upstreamUrl } from "../src/routes.js";

const ok = { path: "/v1/price/:sym", upstream: "https://vendor.example/x402/price/:sym", priceCents: 3, maxUpstreamCents: 2, description: "price" };

describe("parseRoutes", () => {
  it("accepts a valid map and defaults the query allowlist to none", () => {
    expect(parseRoutes([ok])).toEqual([{ ...ok, query: [] }]);
  });

  it.each([
    [{ ...ok, priceCents: 1 }, "at least maxUpstreamCents"],
    [{ ...ok, upstream: "https://vendor.example/price/:other" }, "same :parameters"],
    [{ ...ok, upstream: "ftp://vendor.example/:sym" }, "http(s)"],
    [{ ...ok, path: "v1/price" }, "start with /"],
    [{ ...ok, maxUpstreamCents: 0 }, "positive integer"],
  ])("rejects %j", (route, msg) => {
    expect(() => parseRoutes([route])).toThrow(msg);
  });

  it("rejects duplicates and empty maps", () => {
    expect(() => parseRoutes([ok, ok])).toThrow("duplicate");
    expect(() => parseRoutes([])).toThrow("non-empty");
  });

  it("builds the devnet stand-in from a base URL", () => {
    const r = standInRoutes("http://localhost:4000/");
    expect(r.map((x) => [x.path, x.upstream, x.priceCents])).toEqual([
      ["/v1/data/:topic", "http://localhost:4000/v1/data/:topic", 5],
      ["/v1/data/:topic/depth", "http://localhost:4000/v1/data/:topic/depth", 10],
      ["/v1/data/:topic/signals", "http://localhost:4000/v1/data/:topic/signals", 25],
    ]);
  });
});

describe("upstreamUrl", () => {
  const [route] = parseRoutes([{ ...ok, query: ["interval"] }]);

  it("substitutes parameters and forwards only allowlisted query parameters", () => {
    expect(upstreamUrl(route, { sym: "SOL" }, new URLSearchParams("interval=1h&wallet=agent-7"))).toBe("https://vendor.example/x402/price/SOL?interval=1h");
  });

  it.each(["..", "a/b", "a.b", "%2F", ""])("rejects the value %j", (v) => {
    expect(() => upstreamUrl(route, { sym: v }, new URLSearchParams())).toThrow(BadParamError);
  });
});
