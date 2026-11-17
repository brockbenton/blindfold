import { describe, expect, it } from "vitest";
import { withPublicUrl } from "../src/app.js";

const echo = { fetch: (req: Request) => new Response(req.url) } as any;

describe("withPublicUrl", () => {
  it("drops the local port behind a portless public URL", async () => {
    const f = withPublicUrl(echo, "https://abc.trycloudflare.com");
    expect(await (await f(new Request("http://localhost:4000/v1/data/sol?x=1"))).text()).toBe("https://abc.trycloudflare.com/v1/data/sol?x=1");
  });
  it("keeps an explicit public port", async () => {
    const f = withPublicUrl(echo, "http://localhost:4000");
    expect(await (await f(new Request("http://127.0.0.1:5555/v1/data/sol"))).text()).toBe("http://localhost:4000/v1/data/sol");
  });
});
