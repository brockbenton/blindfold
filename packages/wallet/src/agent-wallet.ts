import { Mint } from "@cashu/cashu-ts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import {
  SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, centsToBaseUnits, loadWalletEnv, signerSet, type WireProof,
} from "@blindfold/protocol";
import { askApproval, type ApprovalOutcome, type Approver } from "./approval.js";
import { CashuClientScheme, type SpendHost } from "./cashu-scheme.js";
import { classify, type MintLike } from "./checkstate.js";
import { PaymentFailed, PaymentRefused, type RefusalReason } from "./errors.js";
import { Mutex } from "./mutex.js";
import { FileTokenStore, type PendingWire, type StoredFile } from "./store.js";

export interface WalletOptions {
  tokenFile?: string;
  maxPerCallCents?: number;
  /** Payments above this many cents need the owner's approval (default 20). Must stay below the cap to matter. */
  approvalOverCents?: number;
  /** Asked before paying above `approvalOverCents`. Without one, such payments are refused. */
  approve?: Approver;
  /** No answer within this time is a denial (default 60 000). */
  approvalTimeoutMs?: number;
  /** Provider pubkeys (hex33). Default: env WALLET_ALLOWLIST, else the union of the proofs' signer sets. */
  allowlist?: string[];
  fetch?: typeof fetch;
  mint?: MintLike;
  usdcMint?: string;
  now?: () => number;
}

export interface PaymentLimits {
  maxCents: number;
  providerPubkeys: readonly string[];
}

export interface RecoverReport {
  returned: number;
  dropped: number;
  stillPending: number;
}

const sum = (ps: WireProof[]) => ps.reduce((s, p) => s + p.amount, 0);

export class AgentWallet implements SpendHost {
  readonly allowlist: readonly string[];
  readonly maxPerCallCents: number;
  readonly usdcMint: string;
  readonly approvalOverCents: number;
  currentUrl = "";
  private limits?: PaymentLimits & { startingBalance: number };
  private approvals = 0;
  private mutex = new Mutex();
  private inFlight = new Map<string, PendingWire>();
  private lastRefusal: PaymentRefused | undefined;
  private attempted = false;
  private failReason: string | undefined;
  private recovery = { returned: 0, dropped: 0 };
  private x402Fetch: typeof fetch;

  private constructor(
    public file: StoredFile,
    private store: FileTokenStore,
    private mint: MintLike,
    private now: () => number,
    allowlist: string[],
    maxPerCallCents: number,
    usdcMint: string,
    fetchImpl: typeof fetch,
    private approval: { overCents: number; approve?: Approver; timeoutMs: number },
  ) {
    this.approvalOverCents = approval.overCents;
    this.allowlist = allowlist;
    this.maxPerCallCents = maxPerCallCents;
    this.usdcMint = usdcMint;
    const client = new x402Client()
      .register(SOLANA_DEVNET_CAIP2, new CashuClientScheme(this))
      .setSpendControls({
        allowedAssets: [{
          network: SOLANA_DEVNET_CAIP2,
          asset: usdcMint,
          maxAmountPerPayment: String(centsToBaseUnits(maxPerCallCents)),
        }],
      });
    this.x402Fetch = wrapFetchWithPayment(fetchImpl, client);
  }

  static async open(opts: WalletOptions = {}): Promise<AgentWallet> {
    const needEnv = !opts.tokenFile || opts.maxPerCallCents === undefined || !opts.allowlist || !opts.usdcMint;
    const env = needEnv ? loadWalletEnv() : undefined;
    const tokenFile = opts.tokenFile ?? env!.TOKEN_FILE;
    const store = new FileTokenStore(tokenFile);
    store.acquireLock();
    try {
      const file = await store.read();
      const all = [...file.proofs, ...(file.pending ?? []).flatMap((e) => e.proofs)];
      let allowlist = opts.allowlist ?? (env && env.WALLET_ALLOWLIST.length ? env.WALLET_ALLOWLIST : undefined);
      if (!allowlist) {
        const u = new Set<string>();
        for (const p of all) {
          try { signerSet(p.secret).forEach((k) => u.add(k)); } catch { /* not a lock: ignore */ }
        }
        allowlist = [...u];
      }
      const w = new AgentWallet(
        file, store, opts.mint ?? new Mint(file.mint), opts.now ?? (() => Math.floor(Date.now() / 1000)),
        allowlist.map((k) => k.toLowerCase()),
        opts.maxPerCallCents ?? env?.MAX_PER_CALL_CENTS ?? 10,
        opts.usdcMint ?? env?.USDC_MINT ?? USDC_DEVNET_MINT,
        opts.fetch ?? globalThis.fetch,
        { overCents: opts.approvalOverCents ?? env?.APPROVAL_OVER_CENTS ?? 20, approve: opts.approve, timeoutMs: opts.approvalTimeoutMs ?? 60_000 },
      );
      await w.recoverPending();
      return w;
    } catch (e) {
      store.releaseSync();
      throw e;
    }
  }

  close(): void {
    this.store.releaseSync();
  }

  balance(): number {
    return sum(this.file.proofs);
  }
  pendingBalance(): number {
    return (this.file.pending ?? []).reduce((s, e) => s + sum(e.proofs), 0);
  }
  proofCount(): number {
    return this.file.proofs.length;
  }

  payFetch = (url: string | URL, init?: RequestInit, limits?: PaymentLimits): Promise<Response> =>
    this.mutex.run(async () => {
      if (limits) this.limits = { ...limits, startingBalance: this.balance() };
      try {
        return await this.doPayFetch(url, init);
      } finally {
        this.limits = undefined;
      }
    });

  paymentBudget(): number {
    return this.limits ? this.limits.maxCents - (this.limits.startingBalance - this.balance()) : Infinity;
  }

  acceptsProvider(pubkey: string): boolean {
    return this.allowlist.includes(pubkey) && (!this.limits || this.limits.providerPubkeys.includes(pubkey));
  }

  recoverPending(): Promise<RecoverReport> {
    return this.mutex.run(async () => {
      const total = { returned: 0, dropped: 0, stillPending: 0 };
      for (const entry of [...(this.file.pending ?? [])]) {
        const r = await this.recoverEntry(entry);
        total.returned += r.returned;
        total.dropped += r.dropped;
      }
      total.stillPending = this.pendingBalance();
      return total;
    });
  }

  // ---- SpendHost ----

  async markPending(chosen: WireProof[]): Promise<PendingWire> {
    const secrets = new Set(chosen.map((p) => p.secret));
    this.file.proofs = this.file.proofs.filter((p) => !secrets.has(p.secret));
    const entry: PendingWire = { proofs: chosen, url: this.currentUrl, sent_at: this.now() };
    (this.file.pending ??= []).push(entry);
    try {
      await this.persist();
    } catch (e) {
      this.file.proofs.push(...chosen);
      this.file.pending.pop();
      throw e;
    }
    this.attempted = true;
    return entry;
  }

  rememberInFlight(token: string, entry: PendingWire): void {
    this.inFlight.set(token, entry);
  }

  requestApproval(cents: number, provider: string): Promise<ApprovalOutcome> {
    return askApproval(this.approval.approve, {
      id: `approval-${process.pid}-${++this.approvals}`, cents, url: this.currentUrl, provider,
      thresholdCents: this.approval.overCents, timeoutMs: this.approval.timeoutMs,
    });
  }

  refused(e: PaymentRefused): void {
    this.lastRefusal = e;
  }

  async paymentSettled(token: string, ok: boolean, errorReason?: string): Promise<void> {
    const entry = this.inFlight.get(token);
    if (!entry) return;
    this.inFlight.delete(token);
    if (ok) {
      await this.dropEntry(entry);
      return;
    }
    if (errorReason) this.failReason = errorReason;
    const r = await this.recoverEntry(entry);
    this.recovery.returned += r.returned;
    this.recovery.dropped += r.dropped;
  }

  // ---- internals ----

  private async persist(): Promise<void> {
    await this.store.write(this.file);
  }

  private async dropEntry(entry: PendingWire): Promise<void> {
    this.file.pending = (this.file.pending ?? []).filter((e) => e !== entry);
    if (this.file.pending.length === 0) delete this.file.pending;
    await this.persist();
  }

  /** Checkstate one pending entry. If the mint cannot be reached the entry stays pending. */
  private async recoverEntry(entry: PendingWire): Promise<{ returned: number; dropped: number }> {
    let c;
    try {
      c = await classify(this.mint, entry.proofs);
    } catch {
      return { returned: 0, dropped: 0 };
    }
    this.file.proofs.push(...c.unspent);
    if (c.pending.length > 0) {
      entry.proofs = c.pending;
      await this.persist();
    } else {
      await this.dropEntry(entry);
    }
    return { returned: sum(c.unspent), dropped: sum(c.spent) };
  }

  private async doPayFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const body = init?.body as unknown;
    if (body && typeof (body as ReadableStream).getReader === "function") {
      throw new PaymentRefused("bad_request", { message: "stream bodies cannot be replayed" });
    }
    const u = new URL(typeof url === "string" ? url : url.toString());
    this.currentUrl = u.origin + u.pathname;
    this.lastRefusal = undefined;
    this.attempted = false;
    this.failReason = undefined;
    this.recovery = { returned: 0, dropped: 0 };
    this.inFlight.clear();

    let res: Response;
    try {
      res = await this.x402Fetch(url, init);
    } catch (e) {
      await this.settleLeftovers();
      throw this.unwrap(e);
    }
    await this.settleLeftovers();
    if (this.attempted && !res.ok) {
      const text = await res.text().catch(() => "");
      throw new PaymentFailed(res.status, text, { ...this.recovery }, this.failReason);
    }
    return res;
  }

  /** Entries whose hook never ran (network error on the paid retry): same treatment as a failure. */
  private async settleLeftovers(): Promise<void> {
    for (const [token] of [...this.inFlight]) await this.paymentSettled(token, false);
  }

  private unwrap(e: unknown): unknown {
    if (e instanceof PaymentRefused) return e;
    const msg = (e as Error)?.message ?? "";
    if (this.lastRefusal && msg.includes("PaymentRefused")) return this.lastRefusal;
    for (let c: unknown = e, i = 0; c && i < 5; i++, c = (c as { cause?: unknown }).cause) {
      if (c instanceof PaymentRefused) return c;
    }
    const m = /PaymentRefused:(\w+)/.exec(msg);
    if (m) return new PaymentRefused(m[1] as RefusalReason);
    if (/rejected by spendControls: only default assets/.test(msg)) return new PaymentRefused("mint", { message: "asset not allowed" });
    if (/rejected by spendControls/.test(msg)) return new PaymentRefused("over_cap", { message: msg });
    if (/No network\/scheme registered|No client registered|Failed to parse payment requirements/.test(msg)) {
      return new PaymentRefused("bad_request", { message: msg });
    }
    return e;
  }
}

