// Copycat's inference and the dashboard's event stream. No chain access: observations are built by hand.
import { afterEach, describe, expect, it } from "vitest";
import type { Observation } from "../lib/bot.js";
import { attributeVault, describe as describeTx, infer, parseMemo } from "../lib/copycat.js";
import { startDashboard, type Dashboard } from "../lib/dashboard.js";

const AGENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
let slot = 100;
const pay = (from: string, memo: string | undefined, secs: number, amountBase = 50_000n): Observation => ({
  kind: "direct_payment", signature: `sig${slot}`, slot: slot++, time: new Date(1_763_166_400_000 + secs * 1000), from, to: "feed", amountBase,
  ...(memo ? { memo } : {}),
});

describe("parseMemo", () => {
  it("reads feed/token memos and ignores x402's random nonce memos", () => {
    expect(parseMemo("whale-flow/SOL")).toEqual({ feed: "whale-flow", token: "SOL" });
    expect(parseMemo("depth/BONK")).toEqual({ feed: "depth", token: "BONK" });
    expect(parseMemo("3f9a1c0b7d2e4f6a8b9c0d1e2f3a4b5c")).toBeNull();
    expect(parseMemo(undefined)).toBeNull();
  });
});

describe("infer", () => {
  it("turns repeated research on one token into a BUY signal for that wallet", () => {
    const [s] = infer([pay(AGENT, "whale-flow/SOL", 0), pay(AGENT, "whale-flow/SOL", 2), pay(AGENT, "depth/SOL", 4, 100_000n)]);
    expect(s).toMatchObject({ payer: AGENT, calls: 3, token: "SOL", tokenCalls: 3, spanSeconds: 4, action: "BUY SOL", totalBase: 200_000n });
    expect(s.feeds).toEqual({ "whale-flow": 2, depth: 1 });
    expect(s.reason).toContain("researching SOL hard");
  });

  it("only watches after a single tagged read", () => {
    expect(infer([pay(AGENT, "whale-flow/ETH", 0)])[0].action).toBe("WATCH ETH");
  });

  it("still follows the wallet when payments carry no readable memo", () => {
    const [s] = infer([pay(AGENT, "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", 0), pay(AGENT, undefined, 3)]);
    expect(s).toMatchObject({ token: null, action: "WATCH WALLET", feeds: { unknown: 2 } });
  });

  it("profiles each payer separately and ignores Blindfold deposits and payouts", () => {
    const vault: Observation[] = [
      { kind: "vault_deposit", signature: "d", slot: 1, time: null, from: OTHER, to: "vault", amountBase: 1_000_000n },
      { kind: "vault_payout", signature: "p", slot: 2, time: null, from: "vault", to: "feed", amountBase: 150_000n },
    ];
    expect(infer(vault)).toEqual([]);
    const both = infer([...vault, pay(AGENT, "whale-flow/SOL", 0), pay(OTHER, "whale-flow/BTC", 1), pay(AGENT, "whale-flow/SOL", 2)]);
    expect(both.map((s) => [s.payer, s.action])).toEqual([[AGENT, "BUY SOL"], [OTHER, "WATCH BTC"]]);
  });

  it("describes each transaction the way Copycat reads it", () => {
    expect(describeTx(pay(AGENT, "whale-flow/SOL", 0))).toBe("7xKX...gAsU paid the feed $0.05 for whale-flow on SOL");
    expect(describeTx({ kind: "vault_payout", signature: "p", slot: 2, time: null, from: "v", to: "f", amountBase: 150_000n })).toContain("Payer: unknown");
  });
});

describe("attributeVault", () => {
  const THIRD = "Hq1UVvYt4dBq3ZBfN7ZtFvr8a2YWzN7GbmJ1cCh5r6Rv";
  const dep = (from: string, amountBase = 1_000_000n): Observation => ({ kind: "vault_deposit", signature: `d${slot}`, slot: slot++, time: null, from, to: "vault", amountBase });
  const out = (amountBase: bigint): Observation => ({ kind: "vault_payout", signature: `p${slot}`, slot: slot++, time: null, from: "vault", to: "feed", amountBase });

  it("links a lone depositor to the payout but never names a token", () => {
    const r = attributeVault([dep(AGENT), out(150_000n)]);
    expect(r).toMatchObject({ action: "LINKED", payouts: 1, payoutBase: 150_000n, forced: [] });
    expect(r.reason).toContain("Only 7xKX...gAsU deposited");
    expect(r.reason).toContain("Which token it researched: unknown");
  });

  it("cannot attribute one payout to any of several equal depositors", () => {
    const r = attributeVault([dep(AGENT), dep(OTHER), dep(THIRD), out(600_000n)]);
    expect(r).toMatchObject({ action: "CANNOT ATTRIBUTE", equalDeposits: true, forced: [] });
    expect(r.depositors).toHaveLength(3);
    expect(r.reason).toBe("3 wallets deposited the same $1.00 each, and 1 payout ($0.60) could be any mix of their purchases. Who bought what, and which token anyone researched: unknown.");
  });

  it("counts repeat deposits per wallet", () => {
    const r = attributeVault([dep(AGENT, 500_000n), dep(AGENT, 500_000n), dep(OTHER), out(100_000n)]);
    expect(r.depositors.find((d) => d.wallet === AGENT)).toMatchObject({ deposits: 2, totalBase: 1_000_000n });
    expect(r).toMatchObject({ action: "CANNOT ATTRIBUTE", equalDeposits: true });
  });

  it("gives away a depositor when amounts leave no other explanation", () => {
    // The two small deposits together hold $0.20, so a $0.50 payout must include the big depositor's money.
    const r = attributeVault([dep(AGENT, 5_000_000n), dep(OTHER, 100_000n), dep(THIRD, 100_000n), out(500_000n)]);
    expect(r).toMatchObject({ action: "PARTIAL", equalDeposits: false, forced: [AGENT] });
    expect(r.reason).toContain("Amounts give it away");
  });

  it("reports nothing before a payout and ignores direct payments", () => {
    expect(attributeVault([dep(AGENT), dep(OTHER)]).action).toBe("NO SIGNAL");
    expect(attributeVault([pay(AGENT, "whale-flow/SOL", 0)])).toMatchObject({ action: "NO SIGNAL", depositors: [] });
  });
});

describe("dashboard", () => {
  let d: Dashboard | undefined;
  afterEach(async () => { await d?.close(); d = undefined; });

  async function read(url: string, n: number): Promise<any[]> {
    const res = await fetch(`${url}/events`);
    const reader = res.body!.getReader();
    const events: any[] = [];
    let buf = "";
    while (events.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (data && data.length > 5) events.push(JSON.parse(data.slice(5)));
      }
    }
    await reader.cancel();
    return events;
  }

  it("serves the crowd page when asked", async () => {
    d = await startDashboard({ port: 0, page: "crowd.html" });
    expect(await (await fetch(d.url)).text()).toContain("<title>Blindfold crowd</title>");
  });

  it("serves the page and replays every event to a late subscriber, then streams new ones", async () => {
    d = await startDashboard({ port: 0 });
    expect(await (await fetch(d.url)).text()).toContain("<title>Blindfold</title>");
    d.emit({ type: "act", n: 1, title: "first" });
    d.emit({ type: "copycat", side: "exact", action: "BUY SOL", reason: "r", tone: "alarm" });
    const pending = read(d.url, 3);
    setTimeout(() => d!.emit({ type: "done", ok: true }), 100);
    const got = await pending;
    expect(got.map((e) => [e.seq, e.type])).toEqual([[1, "act"], [2, "copycat"], [3, "done"]]);
  });
});
