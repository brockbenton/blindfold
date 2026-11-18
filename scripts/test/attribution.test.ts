// The attribution scoreboard (scored against ground truth) and the watcher's slot coverage. No chain access.
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { Observation } from "../lib/bot.js";
import { describeScore, describeVisible, scoreAttribution, type Purchase, type ScoreInput } from "../lib/attribution.js";
import { ChainWatcher, COVERAGE_LAG_SLOTS } from "../lib/copycat.js";

const AGENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const STRANGER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const FEED_WALLET = "feedWallet";
const NEWS_WALLET = "newsWallet";
const names = { [FEED_WALLET]: "TokenFeed", [NEWS_WALLET]: "NewsWire" };
const ACCOUNTS = ["feedAta", "newsAta", "vaultAta"];

const obs = (o: Partial<Observation> & Pick<Observation, "kind" | "signature" | "slot" | "from" | "to">): Observation =>
  ({ time: null, amountBase: 50_000n, ...o });
const direct = (sig: string, slot: number, memo?: string, from = AGENT, to = FEED_WALLET) =>
  obs({ kind: "direct_payment", signature: sig, slot, from, to, ...(memo ? { memo } : {}) });
const deposit = (slot: number, from = OWNER) => obs({ kind: "vault_deposit", signature: `dep${slot}${from.slice(0, 3)}`, slot, from, to: "vault", amountBase: 1_000_000n });
const payout = (slot: number, to: string) => obs({ kind: "vault_payout", signature: `pay${slot}${to}`, slot, from: "vaultAta", to, amountBase: 100_000n });

const exactBuys: Purchase[] = [1, 2, 3].map((n) => ({ side: "exact", buyer: AGENT, provider: "TokenFeed", route: "/v1/data/sol", topic: "sol", at: "", tx: `x${n}` }));
const blindBuys: Purchase[] = [
  ...[1, 2, 3].map((): Purchase => ({ side: "blindfold", buyer: OWNER, provider: "TokenFeed", route: "/v1/data/sol", topic: "sol", at: "" })),
  ...[1, 2].map((): Purchase => ({ side: "blindfold", buyer: OWNER, provider: "NewsWire", route: "/v1/data/sol", topic: "sol", at: "" })),
];
const fullCoverage = Object.fromEntries(ACCOUNTS.map((a) => [a, [{ from: 100, to: 1000 }]]));
const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  purchases: [...exactBuys, ...blindBuys],
  windows: { exact: { from: 110, to: 130 }, blindfold: { from: 200, to: 230 } },
  observations: [
    direct("x1", 112, "whale-flow/SOL"), direct("x2", 115, "whale-flow/SOL"), direct("x3", 118, "whale-flow/SOL"),
    deposit(150), payout(400, FEED_WALLET), payout(400, NEWS_WALLET),
  ],
  coverage: fullCoverage, accounts: ACCOUNTS, names, ...over,
});

describe("scoreAttribution", () => {
  it("scores the demo's run: exact fully attributed, Blindfold only linked through the single deposit", () => {
    const s = scoreAttribution(base());
    expect(s.exact).toMatchObject({ purchases: 3, transfers: 3, correct: 3, partial: 0, incorrect: 0, abstained: 0, verdict: "attributed" });
    expect(s.blindfold).toMatchObject({ purchases: 5, transfers: 0, correct: 0, partial: 5, incorrect: 0, abstained: 0, verdict: "linked" });
    expect(s.blindfold.coverage).toEqual({ complete: true, window: { from: 200, to: 230 }, missing: [] });
    expect(s.vault).toMatchObject({ deposits: 1, payouts: 2, payoutProviders: ["TokenFeed", "NewsWire"], action: "LINKED" });
    expect(describeScore(s.exact)).toBe("3/3 purchases attributed (wallet+feed+topic), 3 per-call transfers, coverage complete");
    expect(describeScore(s.blindfold)).toBe("0/5 purchases attributed (wallet+feed+topic), 5/5 linked to wallet+feed only (topic unknown), 0 per-call transfers, coverage complete");
    expect(describeVisible(s.vault)).toBe("1 vault deposit and 2 batched payouts to TokenFeed and NewsWire; Copycat's reading: LINKED");
  });

  it("abstains on Blindfold purchases when several equal deposits hide the payer", () => {
    const s = scoreAttribution(base({ observations: [...base().observations, deposit(160, STRANGER)] }));
    expect(s.vault.action).toBe("CANNOT ATTRIBUTE");
    expect(s.blindfold).toMatchObject({ correct: 0, partial: 0, abstained: 5, verdict: "not attributed" });
  });

  it("abstains before any payout, and only counts purchases at feeds the batch paid", () => {
    const noPayout = scoreAttribution(base({ observations: base().observations.filter((o) => o.kind !== "vault_payout") }));
    expect(noPayout.blindfold).toMatchObject({ partial: 0, abstained: 5 });
    const feedOnly = scoreAttribution(base({ observations: base().observations.filter((o) => o.to !== NEWS_WALLET) }));
    expect(feedOnly.blindfold).toMatchObject({ partial: 3, abstained: 2 });
  });

  it("counts a deposit by someone else as a misattribution", () => {
    const obsv = base().observations.map((o) => (o.kind === "vault_deposit" ? deposit(150, STRANGER) : o));
    expect(scoreAttribution(base({ observations: obsv })).blindfold).toMatchObject({ incorrect: 5, partial: 0 });
  });

  it("reports an incomplete scan as inconclusive instead of a privacy win", () => {
    const gap = { ...fullCoverage, newsAta: [{ from: 100, to: 210 }, { from: 240, to: 1000 }] };
    const s = scoreAttribution(base({ coverage: gap, observations: [deposit(150), deposit(160, STRANGER)] }));
    expect(s.blindfold).toMatchObject({ abstained: 5, verdict: "inconclusive", coverage: { complete: false, missing: ["newsAta"] } });
    expect(describeScore(s.blindfold)).toContain("coverage incomplete (1 of the watched accounts not fully read), inconclusive");
    // The exact window was read, and its transfers were missed: abstentions there are conclusive.
    expect(s.exact).toMatchObject({ abstained: 3, verdict: "not attributed", coverage: { complete: true } });
    expect(scoreAttribution(base({ coverage: {} })).exact.verdict).toBe("attributed"); // positive evidence stands anyway
  });

  it("without the seller memo, still links each transfer to the wallet and feed but not the topic", () => {
    const nonce = base().observations.map((o) => (o.kind === "direct_payment" ? { ...o, memo: "3f9a1c0b7d2e4f6a8b9c0d1e2f3a4b5c" } : o));
    expect(scoreAttribution(base({ observations: nonce })).exact).toMatchObject({ correct: 0, partial: 3, verdict: "linked" });
  });

  it("marks a wrong topic or provider incorrect, and a missed transfer abstained", () => {
    const wrong = [direct("x1", 112, "whale-flow/BTC"), direct("x2", 115, "whale-flow/SOL", AGENT, NEWS_WALLET)];
    expect(scoreAttribution(base({ observations: wrong })).exact).toMatchObject({ correct: 0, incorrect: 2, abstained: 1, transfers: 2 });
  });

  it("counts every direct payment in a window, and flags ones pinned on the wallet that match no purchase", () => {
    const extra = [...base().observations, direct("other", 120, "whale-flow/SOL", STRANGER), direct("dup", 125, "whale-flow/SOL"), direct("late", 131, "whale-flow/SOL")];
    expect(scoreAttribution(base({ observations: extra })).exact).toMatchObject({ transfers: 5, spurious: 1, correct: 3 });
  });
});

describe("ChainWatcher coverage", () => {
  const account = new PublicKey(AGENT);
  /** An RPC whose signature history is `sigs` (newest first, at most `limit`) at a given head slot. */
  function rpc() {
    const state = { head: 0, sigs: [] as { signature: string; slot: number }[] };
    const connection = {
      getSlot: async () => state.head,
      getSignaturesForAddress: async (_a: PublicKey, o: { limit: number }) =>
        [...state.sigs].sort((a, b) => b.slot - a.slot).slice(0, o.limit).map((s) => ({ ...s, err: null, blockTime: null, memo: null })),
      getParsedTransaction: async () => ({ transaction: { message: { accountKeys: [], instructions: [] } }, meta: { preTokenBalances: [], postTokenBalances: [] } }),
    };
    const w = new ChainWatcher({ connection: connection as any, accounts: [account], usdcMint: account, vaultToken: account, sinceSlot: 100 });
    return { state, w };
  }
  const L = COVERAGE_LAG_SLOTS;

  it("covers from the start slot up to the head minus the lag, extending pass by pass", async () => {
    const { state, w } = rpc();
    state.head = 200;
    state.sigs = [{ signature: "a", slot: 150 }];
    await w.scan();
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 200 - L }]);
    state.head = 300;
    await w.scan();
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 300 - L }]);
  });

  it("leaves a hole when more transactions arrived between passes than one page holds", async () => {
    const { state, w } = rpc();
    state.head = 200;
    await w.scan();
    state.head = 400;
    state.sigs = Array.from({ length: 25 }, (_, i) => ({ signature: `s${i}`, slot: 300 + i }));
    await w.scan();
    // The page of 20 reached back only to slot 305: slots up to 305 after the first range were not all read.
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 200 - L }, { from: 306, to: 400 - L }]);
  });

  it("joins a full page that reaches back into the previous range", async () => {
    const { state, w } = rpc();
    state.head = 200;
    state.sigs = Array.from({ length: 30 }, (_, i) => ({ signature: `old${i}`, slot: 10 + i })); // long history before the run
    await w.scan();
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 200 - L }]);
    state.head = 260;
    state.sigs.push({ signature: "new", slot: 230 });
    await w.scan();
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 260 - L }]);
  });

  it("does not vouch past a transaction it could not read yet", async () => {
    const { state, w } = rpc();
    state.head = 300;
    state.sigs = [{ signature: "pending", slot: 250 }];
    (w as any).o.connection.getParsedTransaction = async () => null;
    await w.scan();
    expect(w.coverage()[AGENT]).toEqual([{ from: 100, to: 249 }]);
  });
});
