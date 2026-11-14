import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { DevDepositor } from "../src/depositor.js";

const ref = new Uint8Array(32).fill(0xab);
const reply = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("DevDepositor", () => {
  it("posts deposit_ref hex and cents with the admin token", async () => {
    let seen: { url: string; auth: string | null; body: unknown } | undefined;
    const f: typeof fetch = async (u, init) => {
      seen = { url: String(u), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ index: 3 }));
    };
    const r = await new DevDepositor({ mintUrl: "http://m/", adminToken: "t", fetch: f }).deposit({ amountCents: 100, depositRef: ref });
    expect(r.signature).toBe("dev-deposit-3");
    expect(seen).toEqual({ url: "http://m/dev/deposit", auth: "Bearer t", body: { deposit_ref: "ab".repeat(32), amount_cents: 100 } });
  });

  it("refuses clearly when the mint is not in fake-chain mode or the token is wrong", async () => {
    const d = (status: number) => new DevDepositor({ mintUrl: "http://m", adminToken: "t", fetch: reply(status) });
    await expect(d(404).deposit({ amountCents: 1, depositRef: ref })).rejects.toThrow(/MINT_DEV_FAKE_CHAIN=1/);
    await expect(d(401).deposit({ amountCents: 1, depositRef: ref })).rejects.toThrow(/MINT_ADMIN_TOKEN/);
  });

  it("owner fund --dev-deposit needs MINT_ADMIN_TOKEN", async () => {
    await expect(runCli(["fund", "--cents", "5", "--dev-deposit"], { out: () => undefined, env: { MINT_URL: "http://127.0.0.1:1" } }))
      .rejects.toThrow(/MINT_ADMIN_TOKEN/);
  });
});
