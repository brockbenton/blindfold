// The attribution scoreboard: how many of the agent's purchases the observer pinned on it, scored against what the
// agent actually bought. The demo writes the ground truth as it buys; the observer never reads it. Scoring only pairs
// the observer's own output (infer, attributeVault, the memo parser) with that list, so a better observer scores better.
//
// What counts as an attribution, per purchase:
// - correct: the observer names the wallet that paid for this purchase, the provider it bought from, and the topic
//   (token) it researched, all three right. The paying wallet is the `exact` agent's wallet for `exact`, and for
//   Blindfold the owner wallet whose vault deposit funded the tokens (the agent itself has no wallet).
// - partial: the wallet and the provider are right, the topic is not named. For Blindfold this is the vault
//   reading: with one depositor in view, the observer links that depositor to every feed the batch paid. It is counted
//   for every purchase at a paid feed, although the observer sees neither the count nor the timing; this errs toward
//   attributing.
// - incorrect: the observer names a wallet, provider or topic for this purchase and one of them is wrong.
// - abstained: nothing the observer output names a wallet for this purchase.
//
// A purchase made with a per-call transfer is paired with the observer's reading of that transaction (the scorer knows
// the signature; the observer does not need to). A purchase with no transfer can only be named through the vault.
//
// Coverage: abstaining is only a privacy result if the observer actually read the slots the purchases happened in. A
// side whose slot window any watched account's coverage does not span is "inconclusive", not a win.
import type { Observation } from "./bot.js";
import { attributeVault, infer, parseMemo, type SlotRange } from "./observer.js";

export type Side = "exact" | "blindfold";

/** One purchase as the demo made it. Ground truth: never shown to the observer. */
export interface Purchase {
  side: Side;
  /** The wallet that paid: the `exact` agent's wallet, or the owner wallet that funded Blindfold tokens. */
  buyer: string;
  /** Provider name, matching the `names` map (e.g. TokenFeed). */
  provider: string;
  route: string;
  /** Token researched, any case (e.g. `sol`). */
  topic: string;
  /** ISO time of the purchase. */
  at: string;
  /** The per-call transfer's signature, when the payment made one. */
  tx?: string;
}

export type Outcome = "correct" | "partial" | "incorrect" | "abstained";

export interface SideScore {
  side: Side;
  purchases: number;
  /** Per-call transfers to a provider (direct payments) the observer saw inside the side's slot window, from anyone. */
  transfers: number;
  correct: number;
  partial: number;
  incorrect: number;
  abstained: number;
  /** Direct payments in the window that the observer pinned on this side's wallet but match no purchase. */
  spurious: number;
  coverage: { complete: boolean; window: SlotRange; missing: string[] };
  /**
   * `attributed`: at least one purchase fully attributed. `inconclusive`: none, and coverage is incomplete.
   * `linked`: only partial attributions. `not attributed`: coverage complete, nothing named.
   */
  verdict: "attributed" | "linked" | "not attributed" | "inconclusive";
  outcomes: Outcome[];
}

export interface Scoreboard {
  exact: SideScore;
  blindfold: SideScore;
  /** What the observer still sees of the Blindfold side: vault deposits and batched payouts, and its reading of them. */
  vault: { deposits: number; payouts: number; payoutProviders: string[]; action: string; reason: string };
}

export interface ScoreInput {
  purchases: Purchase[];
  /** Slot window per side: from before its first purchase to after its last. */
  windows: Record<Side, SlotRange>;
  /** Everything the observer observed in the run. */
  observations: Observation[];
  /** Per watched token account, slot ranges the observer read completely (ChainWatcher.coverage). */
  coverage: Record<string, SlotRange[]>;
  /** The watched token accounts that must cover each window. */
  accounts: string[];
  /** Payout wallet -> provider name. */
  names: Record<string, string>;
}

const covers = (ranges: SlotRange[] | undefined, w: SlotRange) => (ranges ?? []).some((r) => r.from <= w.from && r.to >= w.to);

export function scoreAttribution(input: ScoreInput): Scoreboard {
  const { purchases, windows, observations: obs, names } = input;
  const providerOf = (o: Observation) => names[o.to] ?? o.to;
  const signals = new Map(infer(obs).map((s) => [s.payer, s]));
  const vault = attributeVault(obs);
  const payouts = obs.filter((o) => o.kind === "vault_payout");
  const payoutProviders = [...new Set(payouts.map(providerOf))];
  // The wallet the vault reading pins the payouts on, if any.
  const vaultBuyer = (truth: string): string | null => {
    if (vault.action === "LINKED") return vault.depositors[0].wallet;
    if (vault.action === "PARTIAL") return vault.forced.includes(truth) ? truth : vault.forced.length === 1 ? vault.forced[0] : null;
    return null;
  };

  const judge = (p: Purchase): Outcome => {
    const topic = p.topic.toUpperCase();
    if (p.tx) {
      const o = obs.find((x) => x.signature === p.tx && x.kind === "direct_payment");
      if (!o) return "abstained";
      const claimed = parseMemo(o.memo)?.token ?? signals.get(o.from)?.token ?? null;
      if (o.from !== p.buyer || providerOf(o) !== p.provider || (claimed !== null && claimed.toUpperCase() !== topic)) return "incorrect";
      return claimed === null ? "partial" : "correct";
    }
    const who = vaultBuyer(p.buyer);
    if (who === null || !payoutProviders.includes(p.provider)) return "abstained";
    return who === p.buyer ? "partial" : "incorrect";
  };

  const side = (s: Side): SideScore => {
    const mine = purchases.filter((p) => p.side === s);
    const w = windows[s];
    const inWindow = obs.filter((o) => o.kind === "direct_payment" && o.slot >= w.from && o.slot <= w.to);
    const buyers = new Set(mine.map((p) => p.buyer));
    const txs = new Set(mine.map((p) => p.tx).filter(Boolean));
    const outcomes = mine.map(judge);
    const count = (k: Outcome) => outcomes.filter((x) => x === k).length;
    const missing = input.accounts.filter((a) => !covers(input.coverage[a], w));
    const complete = missing.length === 0;
    const correct = count("correct");
    const partial = count("partial");
    return {
      side: s, purchases: mine.length, transfers: inWindow.length, correct, partial, incorrect: count("incorrect"), abstained: count("abstained"),
      spurious: inWindow.filter((o) => buyers.has(o.from) && !txs.has(o.signature)).length,
      coverage: { complete, window: { ...w }, missing },
      verdict: correct > 0 ? "attributed" : !complete ? "inconclusive" : partial > 0 ? "linked" : "not attributed",
      outcomes,
    };
  };

  return {
    exact: side("exact"),
    blindfold: side("blindfold"),
    vault: { deposits: obs.filter((o) => o.kind === "vault_deposit").length, payouts: payouts.length, payoutProviders, action: vault.action, reason: vault.reason },
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per side, e.g. `3/3 purchases attributed (wallet+feed+topic), 3 per-call transfers, coverage complete`. */
export function describeScore(s: SideScore): string {
  const parts = [`${s.correct}/${s.purchases} purchases attributed (wallet+feed+topic)`];
  if (s.partial) parts.push(`${s.partial}/${s.purchases} linked to wallet+feed only (topic unknown)`);
  if (s.incorrect) parts.push(`${s.incorrect} misattributed`);
  if (s.spurious) parts.push(`${s.spurious} unrelated ${s.spurious === 1 ? "transfer" : "transfers"} pinned on the wallet`);
  parts.push(plural(s.transfers, "per-call transfer"));
  parts.push(s.coverage.complete ? "coverage complete" : `coverage incomplete (${s.coverage.missing.length} of the watched accounts not fully read), inconclusive`);
  return parts.join(", ");
}

/** What the observer still sees on the Blindfold side. */
export function describeVisible(b: Scoreboard["vault"]): string {
  const paid = b.payoutProviders.length ? ` to ${b.payoutProviders.join(" and ")}` : "";
  return `${plural(b.deposits, "vault deposit")} and ${plural(b.payouts, "batched payout")}${paid}; the observer's reading: ${b.action}`;
}
