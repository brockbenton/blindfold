import { describe, expect, it } from "vitest";
import { PaymentFailed, PaymentRefused } from "@blindfold/wallet";
import type { ProviderInfo } from "@blindfold/protocol";
import { runMain } from "../src/main.js";
import { HttpError, NetworkError, NoProviderError } from "../src/errors.js";
import { runScripted } from "../src/scripted.js";
import { fakeProviders } from "../src/stubs.js";
import type { Tools } from "../src/tools.js";

async function cli(argv: string[], env: Record<string, string> = {}, tools?: Tools) {
  let stdout = "", stderr = "";
  const code = await runMain(argv, { AGENT_FAKE: "1", ...env }, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, { tools });
  return { code, stdout, stderr };
}

describe("agent --fake --json", () => {
  it("exits 0 and prints one JSON line with balanceBefore - balanceAfter == paidCents", async () => {
    const r = await cli(["--json"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    const j = JSON.parse(r.stdout);
    expect(j.ok).toBe(true);
    expect(j.balanceBefore - j.balanceAfter).toBe(j.paidCents);
    expect(j.paidCents).toBe(5);
    expect(j.calls[0].status).toBe(200);
    expect(j.reserves).toMatchObject({ ok: true, vaultCents: 250, outstandingCents: 180 });
  });
  it("human output has the documented lines", async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provider   mock-api (http://localhost:4000)");
    expect(r.stdout).toContain("balance    100c -> 95c");
    expect(r.stdout).toContain("(ok; mint-reported, unverified)");
  });
});

describe("exit codes", () => {
  it("3: empty wallet, over_cap", async () => {
    let r = await cli(["--json"], { FAKE_START_CENTS: "0" });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error).toMatchObject({ kind: "payment_refused", reason: "insufficient_balance" });
    r = await cli(["--json"], { FAKE_PRICE_CENTS: "20" });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout).error.reason).toBe("over_cap");
  });
  it("5: PaymentFailed 402", async () => {
    const r = await cli(["--json"], { FAKE_FAIL_STATUS: "402" });
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stdout).error).toMatchObject({ kind: "http", status: 402 });
  });
  it("7: reserves not ok, nothing paid, reason printed", async () => {
    const r = await cli(["--json"], { FAKE_RESERVES_FAIL: "1" });
    expect(r.code).toBe(7);
    expect(JSON.parse(r.stdout).error).toMatchObject({
      kind: "reserves_failed", reason: "vault_below_outstanding", reserves: { ok: false },
    });
    const h = await cli([], { FAKE_RESERVES_FAIL: "1" });
    expect(h.stderr).toContain("error: reserves_failed: vault_below_outstanding");
  });
  it("2: config errors", async () => {
    expect((await cli(["--calls", "0"])).code).toBe(2);
    expect((await cli(["--bogus"])).code).toBe(2);
    expect((await cli(["--approve-over", "-1"])).code).toBe(2);
    const r = await cli([], { AGENT_FAKE: "" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("TOKEN_FILE");
  });
  it.each([["--json", "--bogus"], ["--bogus", "--json"], ["--json", "--calls"]])(
    "reports parse errors as JSON for %j", async (...argv) => {
      const r = await cli(argv);
      expect(r.code).toBe(2);
      expect(r.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: { kind: "config" } });
      expect(r.stderr).toBe("");
    },
  );
  it("4, 5, 6 from tools", async () => {
    const base = (over: Partial<Tools>): Tools => ({
      balance: async () => ({ cents: 100 }), list_providers: async () => fakeProviders,
      call_paid_api: async () => ({ status: 200, data: {}, paidCents: 5 }), check_reserves: async () => ({ ok: true, vaultCents: 1, outstandingCents: 0 }),
      report: async () => undefined, ...over,
    });
    expect((await cli([], {}, base({ list_providers: async () => { throw new NetworkError("down"); } }))).code).toBe(4);
    expect((await cli([], {}, base({ call_paid_api: async () => { throw new TypeError("fetch failed"); } }))).code).toBe(4);
    expect((await cli([], {}, base({ call_paid_api: async () => { throw new HttpError(404, "no"); } }))).code).toBe(5);
    expect((await cli([], {}, base({ list_providers: async () => [] }))).code).toBe(6);
    expect((await cli(["--provider", "nope"], {}, base({}))).code).toBe(6);
    expect((await cli([], {}, base({ call_paid_api: async () => { throw new Error("boom"); } }))).code).toBe(1);
    void PaymentFailed; void PaymentRefused; void NoProviderError;
  });
});

describe("reserve gate", () => {
  const mk = (log: string[], over: Partial<Tools> = {}): Tools => ({
    balance: async () => ({ cents: 100 }), list_providers: async () => fakeProviders,
    call_paid_api: async () => { log.push("pay"); return { status: 200, data: {}, paidCents: 5 }; },
    check_reserves: async () => { log.push("check"); return { ok: true, vaultCents: 9, outstandingCents: 1 }; },
    report: async () => undefined, ...over,
  });
  it("checks before the first call and every RESERVE_CHECK_EVERY calls", async () => {
    const log: string[] = [];
    await runScripted(mk(log), { topic: "sol", calls: 5, reserveEvery: 2 });
    expect(log).toEqual(["check", "pay", "pay", "check", "pay", "pay", "check", "pay"]);
  });
  it("a failed check or a throwing check pays nothing", async () => {
    const log: string[] = [];
    await expect(runScripted(mk(log, { check_reserves: async () => ({ ok: false, vaultCents: 0, outstandingCents: 1, reason: "rpc" }) }), { topic: "sol", calls: 1, reserveEvery: 10 })).rejects.toThrow("rpc");
    expect(log).toEqual([]);
  });
  it("picks by topic, then --provider, else first", async () => {
    const ps: ProviderInfo[] = [
      { ...fakeProviders[0], name: "a", url: "http://a", topics: ["btc"] },
      { ...fakeProviders[0], name: "b", url: "http://b", topics: ["sol"] },
    ];
    const urls: string[] = [];
    const t = mk([], { list_providers: async () => ps, call_paid_api: async (x) => { urls.push(x.url); return { status: 200, data: {}, paidCents: 5 }; } });
    await runScripted(t, { topic: "sol", calls: 1, reserveEvery: 10 });
    await runScripted(t, { topic: "sol", provider: "a", calls: 1, reserveEvery: 10 });
    await runScripted(t, { topic: "doge", calls: 1, reserveEvery: 10 });
    expect(urls).toEqual(["http://b/v1/data/sol", "http://a/v1/data/sol", "http://a/v1/data/doge"]);
  });
});
