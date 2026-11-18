// The observer: a front-running bot that reads only public Solana data. It watches a data provider's USDC account and
// the Blindfold vault, profiles every wallet that pays the provider directly, and turns purchase patterns into
// trading signals. It has no access to the mint, the provider's logs or any wallet.
import { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT } from "@blindfold/protocol";
import { getParsed, getSignatures, toObservation, type Observation } from "./bot.js";

/** Feed and token from a seller's x402 memo such as `whale-flow/SOL`; random nonce memos parse to null. */
export function parseMemo(memo: string | undefined): { feed: string; token: string } | null {
  const m = /^([a-z][a-z-]{0,31})\/([A-Z0-9]{1,16})$/.exec(memo ?? "");
  return m ? { feed: m[1], token: m[2] } : null;
}

export interface Signal {
  payer: string;
  calls: number;
  totalBase: bigint;
  /** Purchases per feed (`unknown` when the payment carries no readable memo). */
  feeds: Record<string, number>;
  /** The token most purchases were about, when memos name one. */
  token: string | null;
  tokenCalls: number;
  spanSeconds: number | null;
  /** What the observer does: `BUY SOL`, `WATCH SOL` or `WATCH WALLET`. */
  action: string;
  /** The observer's reasoning, one sentence. */
  reason: string;
}

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One signal per wallet that paid the provider directly. Repeated research on one token means a trade is coming,
 * so the observer buys first; a single purchase is only worth watching. The observer cannot see the data the agent bought, so
 * the direction is its bet, not knowledge.
 */
export function infer(obs: Observation[]): Signal[] {
  const by = new Map<string, Observation[]>();
  for (const o of obs) if (o.kind === "direct_payment") by.set(o.from, [...(by.get(o.from) ?? []), o]);
  return [...by.entries()].map(([payer, ps]) => {
    const feeds: Record<string, number> = {};
    const tokens = new Map<string, number>();
    for (const p of ps) {
      const tag = parseMemo(p.memo);
      feeds[tag?.feed ?? "unknown"] = (feeds[tag?.feed ?? "unknown"] ?? 0) + 1;
      if (tag) tokens.set(tag.token, (tokens.get(tag.token) ?? 0) + 1);
    }
    const [token, tokenCalls] = [...tokens.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const times = ps.map((p) => p.time?.getTime()).filter((t): t is number => t !== undefined);
    const spanSeconds = times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 1000) : null;
    const within = spanSeconds !== null ? ` in ${plural(Math.max(spanSeconds, 1), "second")}` : "";
    const feedList = Object.entries(feeds).map(([f, n]) => `${n} ${f}`).join(", ");
    const kinds = Object.keys(feeds);
    const reads = (n: number) => kinds.length === 1 ? plural(n, `${kinds[0]} read`) : `${plural(n, "paid read")} (${feedList})`;
    let action: string;
    let reason: string;
    if (token && tokenCalls >= 2) {
      action = `BUY ${token}`;
      reason = `Agent ${short(payer)} is researching ${token} hard: ${reads(tokenCalls)}${within}. A trade is coming; buy ${token} before it does.`;
    } else if (token) {
      action = `WATCH ${token}`;
      reason = `Agent ${short(payer)} paid for ${token} data once. One read is not a pattern yet; keep watching.`;
    } else {
      action = "WATCH WALLET";
      reason = `Agent ${short(payer)} bought token data ${plural(ps.length, "time")}${within}. The token is not tagged, but the wallet is: follow its next trade.`;
    }
    return { payer, calls: ps.length, totalBase: ps.reduce((s, p) => s + p.amountBase, 0n), feeds, token, tokenCalls, spanSeconds, action, reason };
  });
}

export interface VaultReading {
  /** Wallets that deposited into the vault in the watched window, with their totals. */
  depositors: { wallet: string; deposits: number; totalBase: bigint }[];
  payouts: number;
  payoutBase: bigint;
  /** Every depositor put in the same total, so amounts cannot tell them apart. */
  equalDeposits: boolean;
  /** Depositors whose money must be in the payouts: everyone else's deposits together cannot cover them. */
  forced: string[];
  /**
   * `NO SIGNAL`: nothing paid out yet, or no deposit in view. `LINKED`: one depositor, so it funded the payouts. `PARTIAL`: amounts force
   * some depositors into the payouts. `CANNOT ATTRIBUTE`: any depositor could have bought any of it.
   */
  action: "NO SIGNAL" | "LINKED" | "PARTIAL" | "CANNOT ATTRIBUTE";
  reason: string;
}

/**
 * What the observer can say about Blindfold users from vault deposits and payouts alone. Payouts carry no payer and no
 * memo, so the token researched is never visible; the question is only whether a payout can be pinned on a wallet.
 * It sees only the watched window: deposits from before it widen the real crowd, so this errs toward attributing.
 */
export function attributeVault(obs: Observation[]): VaultReading {
  const by = new Map<string, { wallet: string; deposits: number; totalBase: bigint }>();
  for (const o of obs) {
    if (o.kind !== "vault_deposit") continue;
    const d = by.get(o.from) ?? { wallet: o.from, deposits: 0, totalBase: 0n };
    d.deposits++;
    d.totalBase += o.amountBase;
    by.set(o.from, d);
  }
  const depositors = [...by.values()];
  const payoutList = obs.filter((o) => o.kind === "vault_payout");
  const payoutBase = payoutList.reduce((s, o) => s + o.amountBase, 0n);
  const total = depositors.reduce((s, d) => s + d.totalBase, 0n);
  const equalDeposits = depositors.length > 1 && depositors.every((d) => d.totalBase === depositors[0].totalBase);
  const forced = depositors.length > 1 ? depositors.filter((d) => total - d.totalBase < payoutBase).map((d) => d.wallet) : [];
  const usd = (b: bigint) => `$${(Number(b) / 1e6).toFixed(2)}`;
  const paid = `${plural(payoutList.length, "payout")} (${usd(payoutBase)})`;
  const base = { depositors, payouts: payoutList.length, payoutBase, equalDeposits, forced };
  if (payoutList.length === 0) {
    return { ...base, action: "NO SIGNAL", reason: `${plural(depositors.length, "deposit")} into the vault, nothing paid out yet. Who will buy what: unknown.` };
  }
  if (depositors.length === 0) {
    return { ...base, action: "NO SIGNAL", reason: `${paid} from the vault, but no deposit in view to pin ${payoutList.length === 1 ? "it" : "them"} on. Who paid: unknown.` };
  }
  if (depositors.length === 1) {
    return {
      ...base, action: "LINKED",
      reason: `Only ${short(depositors[0].wallet)} deposited in this window, so it funded the ${paid} to the feed. Which token it researched: unknown, but the wallet is linked to the feed.`,
    };
  }
  const amounts = equalDeposits ? `the same ${usd(depositors[0].totalBase)} each` : `${usd(total)} between them`;
  if (forced.length) {
    return {
      ...base, action: "PARTIAL",
      reason: `${depositors.length} wallets deposited ${amounts}, but the ${paid} ${payoutList.length === 1 ? "is" : "are"} more than the others could cover without ${forced.map(short).join(", ")}. Amounts give ${forced.length === 1 ? "it" : "them"} away; tokens: unknown.`,
    };
  }
  return {
    ...base, action: "CANNOT ATTRIBUTE",
    reason: `${depositors.length} wallets deposited ${amounts}, and ${paid} could be any mix of their purchases. Who bought what, and which token anyone researched: unknown.`,
  };
}

/** The observer's one-line reading of a single transaction, for live feeds. `names` maps payout wallets to feed names. */
export function describe(o: Observation, names: Record<string, string> = {}): string {
  const usd = `$${(Number(o.amountBase) / 1e6).toFixed(2)}`;
  if (o.kind === "direct_payment") {
    const tag = parseMemo(o.memo);
    return `${short(o.from)} paid the feed ${usd}${tag ? ` for ${tag.feed} on ${tag.token}` : ""}`;
  }
  if (o.kind === "vault_payout") return `Blindfold vault paid ${names[o.to] ?? "the feed"} ${usd} in a batch. Payer: unknown`;
  return `${short(o.from)} deposited ${usd} into the Blindfold vault. What it buys: unknown`;
}

/** An inclusive slot range. */
export interface SlotRange { from: number; to: number }

/** Signatures fetched per account per pass. */
const SIG_LIMIT = 20;
/**
 * Slots below the head a pass vouches for. RPC signature history can trail the confirmed slot by a few seconds,
 * so a pass only claims the slots it is sure the history already lists.
 */
export const COVERAGE_LAG_SLOTS = 16;

/**
 * Polls token accounts for new transactions and reports each observation once. Only new signatures are fetched,
 * which keeps a rate-limited public RPC usable for the rest of the demo.
 */
export class ChainWatcher {
  readonly observations: Observation[] = [];
  /** `account:signature` pairs already fetched (or skipped), and those reported as observations. */
  private readonly seen = new Set<string>();
  private readonly reported = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;
  /** Per account, the slot ranges whose transactions RPC passes have fully read (see `coverage`). */
  private readonly covered = new Map<string, SlotRange[]>();

  constructor(private readonly o: {
    connection: Connection; accounts: PublicKey[]; usdcMint: PublicKey; vaultToken: PublicKey; sinceSlot?: number;
    intervalMs?: number; onObservation?: (ob: Observation) => void; onError?: (e: unknown) => void;
  }) {}

  start(): this {
    if (this.timer) return this;
    const tick = () => {
      this.scan().catch((e) => this.o.onError?.(e)).finally(() => {
        if (this.timer) this.timer = setTimeout(tick, this.o.intervalMs ?? 4000);
      });
    };
    this.timer = setTimeout(tick, 0);
    return this;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass over every account. Concurrent callers share the pass in progress. */
  scan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async doScan() {
    // The head before reading history: every pass vouches only for slots up to it (minus the lag).
    const head = await this.o.connection.getSlot(SOLANA_COMMITMENT).catch(() => null);
    for (const account of this.o.accounts) {
      const sigs = await getSignatures(this.o.connection, account, SIG_LIMIT);
      let unread: number | null = null;
      // Oldest first, so live feeds show transactions in chain order.
      for (const s of [...sigs].reverse()) {
        const key = `${account.toBase58()}:${s.signature}`;
        if (this.seen.has(key)) continue;
        if (s.err || (this.o.sinceSlot !== undefined && s.slot < this.o.sinceSlot)) { this.seen.add(key); continue; }
        const tx = await getParsed(this.o.connection, s.signature);
        if (!tx) { unread = Math.min(unread ?? s.slot, s.slot); continue; } // not visible yet at this commitment; retried next pass
        if (this.seen.has(key)) continue; // delivered by a Stream while this fetch was in flight
        this.seen.add(key);
        const ob = toObservation(tx, s, account, this.o.usdcMint, this.o.vaultToken);
        if (ob) this.ingest(account.toBase58(), { ...ob, via: "rpc" });
      }
      if (head !== null) this.cover(account.toBase58(), sigs.map((s) => s.slot), Math.min(head - COVERAGE_LAG_SLOTS, unread === null ? Infinity : unread - 1));
    }
  }

  /**
   * Records what one pass over `account` read: every transaction from its oldest returned signature up to `to`. A
   * full page (SIG_LIMIT signatures) may have cut off older ones, so it joins the previous range only if it reaches
   * back into it; otherwise a hole is left and coverage restarts after the oldest slot read.
   */
  private cover(account: string, slots: number[], to: number) {
    const ranges = this.covered.get(account) ?? [];
    this.covered.set(account, ranges);
    const complete = slots.length < SIG_LIMIT; // the account's whole history fit in one page
    const oldest = slots.length ? Math.min(...slots) : Infinity;
    const last = ranges.at(-1);
    if (last && (complete || oldest <= last.to)) { last.to = Math.max(last.to, to); return; }
    const since = this.o.sinceSlot ?? 0;
    const from = complete || (!last && oldest < since) ? since : oldest + 1;
    if (to >= from) ranges.push({ from, to });
  }

  /**
   * Slot ranges, per watched token account, in which RPC passes read every transaction. A gap means more
   * transactions arrived between two passes than one page holds, so the observer may have missed some there.
   */
  coverage(): Record<string, SlotRange[]> {
    return Object.fromEntries([...this.covered].map(([a, r]) => [a, r.map((x) => ({ ...x }))]));
  }

  /**
   * Adds an observation of USDC arriving at `account` unless that transaction was already reported for it. RPC
   * polls and Stream deliveries share this, so each transaction is reported once whichever source sees it first.
   */
  ingest(account: string, ob: Observation): boolean {
    const key = `${account}:${ob.signature}`;
    if (this.reported.has(key)) return false;
    this.reported.add(key);
    this.seen.add(key);
    this.observations.push(ob);
    this.observations.sort((a, b) => a.slot - b.slot);
    this.o.onObservation?.(ob);
    return true;
  }

  /** Scans until `want` holds or the timeout passes (RPC history lags confirmation by a few seconds). */
  async waitFor(want: (obs: Observation[]) => boolean, timeoutMs = 60_000): Promise<Observation[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (want(this.observations)) return this.observations;
      if (Date.now() > deadline) return this.observations;
      await this.scan().catch((e) => this.o.onError?.(e));
      if (!want(this.observations)) await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
