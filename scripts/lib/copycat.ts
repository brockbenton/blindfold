// Copycat: a front-running bot that reads only public Solana data. It watches a data provider's USDC account and
// the Blindfold vault, profiles every wallet that pays the provider directly, and turns purchase patterns into
// trading signals. It has no access to the mint, the provider's logs or any wallet.
import { Connection, PublicKey } from "@solana/web3.js";
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
  /** What Copycat does: `BUY SOL`, `WATCH SOL` or `WATCH WALLET`. */
  action: string;
  /** Copycat's reasoning, one sentence. */
  reason: string;
}

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One signal per wallet that paid the provider directly. Repeated research on one token means a trade is coming,
 * so Copycat buys first; a single purchase is only worth watching. Copycat cannot see the data the agent bought, so
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

/** Copycat's one-line reading of a single transaction, for live feeds. `names` maps payout wallets to feed names. */
export function describe(o: Observation, names: Record<string, string> = {}): string {
  const usd = `$${(Number(o.amountBase) / 1e6).toFixed(2)}`;
  if (o.kind === "direct_payment") {
    const tag = parseMemo(o.memo);
    return `${short(o.from)} paid the feed ${usd}${tag ? ` for ${tag.feed} on ${tag.token}` : ""}`;
  }
  if (o.kind === "vault_payout") return `Blindfold vault paid ${names[o.to] ?? "the feed"} ${usd} in a batch. Payer: unknown`;
  return `${short(o.from)} deposited ${usd} into the Blindfold vault. What it buys: unknown`;
}

/**
 * Polls token accounts for new transactions and reports each observation once. Only new signatures are fetched,
 * which keeps a rate-limited public RPC usable for the rest of the demo.
 */
export class ChainWatcher {
  readonly observations: Observation[] = [];
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private scanning: Promise<void> | null = null;

  constructor(private readonly o: {
    connection: Connection; accounts: PublicKey[]; usdcMint: PublicKey; vaultToken: PublicKey; sinceSlot?: number;
    intervalMs?: number; onObservation?: (ob: Observation) => void; onError?: (e: unknown) => void;
  }) {}

  start(): this {
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
    for (const account of this.o.accounts) {
      const sigs = await getSignatures(this.o.connection, account, 20);
      // Oldest first, so live feeds show transactions in chain order.
      for (const s of sigs.reverse()) {
        const key = `${account.toBase58()}:${s.signature}`;
        if (this.seen.has(key)) continue;
        if (s.err || (this.o.sinceSlot !== undefined && s.slot < this.o.sinceSlot)) { this.seen.add(key); continue; }
        const tx = await getParsed(this.o.connection, s.signature);
        if (!tx) continue; // not visible yet at this commitment; retried next pass
        this.seen.add(key);
        const ob = toObservation(tx, s, account, this.o.usdcMint, this.o.vaultToken);
        if (!ob) continue;
        this.observations.push(ob);
        this.observations.sort((a, b) => a.slot - b.slot);
        this.o.onObservation?.(ob);
      }
    }
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
