// Owner approval for large purchases (04-wallet-sdk.md, "Owner approval"). The wallet asks an Approver before paying
// more than its approval threshold; no answer before the timeout counts as a denial. Approvers are pluggable: a
// terminal prompt, a broker that a UI resolves (the demo dashboard), or several raced together.
import { createInterface } from "node:readline/promises";

export interface ApprovalRequest {
  /** Unique per request; a UI posts its answer back with this id. */
  id: string;
  /** The exact price from the provider's 402 challenge. */
  cents: number;
  /** origin + path of the resource being bought. */
  url: string;
  /** Provider pubkey (hex33) that will redeem the payment. */
  provider: string;
  thresholdCents: number;
  timeoutMs: number;
}

/** Resolves true to pay, false to refuse. `signal` aborts when the wallet stops waiting (timeout or another answer). */
export type Approver = (req: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;

export type ApprovalOutcome = "approved" | "denied" | "timeout";

/**
 * Asks `approve` and enforces the deadline in code: a missing approver, an error or a late answer is a refusal.
 * Never throws.
 */
export async function askApproval(approve: Approver | undefined, req: ApprovalRequest): Promise<ApprovalOutcome> {
  if (!approve) return "denied";
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ApprovalOutcome>((r) => { timer = setTimeout(() => r("timeout"), req.timeoutMs); });
  const answer = Promise.resolve()
    .then(() => approve(req, ac.signal))
    .then((ok): ApprovalOutcome => (ok === true ? "approved" : "denied"), (): ApprovalOutcome => "denied");
  const outcome = await Promise.race([answer, timeout]);
  clearTimeout(timer);
  ac.abort(outcome);
  return outcome;
}

/** Why a request's signal was aborted: the final outcome when known (another approver answered), else a timeout. */
const outcomeOf = (reason: unknown): ApprovalOutcome =>
  reason === "approved" || reason === "denied" ? reason : "timeout";

/** Approves or denies everything. Useful for tests and unattended runs. */
export const fixedApprover = (ok: boolean): Approver => async () => ok;

/** The first approver to answer wins; the others are aborted. */
export function anyApprover(...approvers: Approver[]): Approver {
  return (req, signal) => new Promise<boolean>((resolve, reject) => {
    const ac = new AbortController();
    signal.addEventListener("abort", () => ac.abort(signal.reason), { once: true });
    let failed = 0;
    for (const a of approvers) {
      a(req, ac.signal).then(
        (ok) => { ac.abort(ok ? "approved" : "denied"); resolve(ok); },
        (e) => { if (++failed === approvers.length) reject(e); },
      );
    }
  });
}

/** Prompts on a terminal: `y` approves, anything else denies. Gives up (no answer) when aborted. */
export function terminalApprover(o: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; format?: (r: ApprovalRequest) => string } = {}): Approver {
  return async (req, signal) => {
    const rl = createInterface({ input: o.input ?? process.stdin, output: o.output ?? process.stderr });
    const text = o.format?.(req)
      ?? `Approve paying ${req.cents} cents for ${req.url}? (over the ${req.thresholdCents}-cent limit; denied in ${Math.round(req.timeoutMs / 1000)} s) [y/N] `;
    try {
      const a = await rl.question(text, { signal });
      return /^y(es)?$/i.test(a.trim());
    } catch (e) {
      if (signal.aborted) (o.output ?? process.stderr).write(`${outcomeOf(signal.reason)}\n`);
      throw e;
    } finally {
      rl.close();
    }
  };
}

/**
 * Pending requests that something else answers, such as a web UI. `approver` registers each request and calls
 * `onRequest`; `resolve(id, ok)` answers it. An aborted request (timeout) is dropped and reported to `onDone`.
 */
export function approvalBroker(o: { onRequest?: (r: ApprovalRequest) => void; onDone?: (r: ApprovalRequest, outcome: ApprovalOutcome) => void } = {}) {
  const pending = new Map<string, { req: ApprovalRequest; answer: (ok: boolean) => void }>();
  const approver: Approver = (req, signal) => new Promise<boolean>((resolve) => {
    if (signal.aborted) return;
    pending.set(req.id, {
      req,
      answer: (ok) => { pending.delete(req.id); o.onDone?.(req, ok ? "approved" : "denied"); resolve(ok); },
    });
    signal.addEventListener("abort", () => {
      if (pending.delete(req.id)) o.onDone?.(req, outcomeOf(signal.reason));
    }, { once: true });
    o.onRequest?.(req);
  });
  return {
    approver,
    /** Returns false when no such request is pending (already answered or timed out). */
    resolve(id: string, ok: boolean): boolean {
      const p = pending.get(id);
      if (!p) return false;
      p.answer(ok);
      return true;
    },
    pending: () => [...pending.values()].map((p) => p.req),
  };
}
