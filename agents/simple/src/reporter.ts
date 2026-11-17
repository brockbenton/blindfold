import type { ProviderInfo } from "@blindfold/protocol";
import type { LlmRunResult } from "./llm.js";

export interface ReserveSummary {
  ok: boolean;
  vaultCents: number;
  outstandingCents: number;
  reason?: string;
}

export interface CallResult {
  status: number;
  paidCents: number;
  data: unknown;
  redemptionId?: string;
}

export interface RunResult {
  ok: true;
  provider: ProviderInfo;
  topic: string;
  calls: CallResult[];
  balanceBefore: number;
  balanceAfter: number;
  paidCents: number;
  reserves: ReserveSummary | null;
}

export interface ErrorReport {
  kind: "payment_refused" | "reserves_failed" | "network" | "http" | "no_provider" | "config" | "internal";
  message: string;
  reason?: string;
  status?: number;
}

/** Where the agent's output goes. JSON mode keeps stdout to exactly one line. */
export interface Reporter {
  log(line: string): void;
  result(r: RunResult | LlmRunResult): void;
  error(e: ErrorReport): void;
}

export function humanReporter(io: { stdout: (s: string) => void; stderr: (s: string) => void }): Reporter {
  return {
    log: (l) => io.stderr(`${l}\n`),
    result(r) {
      if ("mode" in r) {
        for (const s of r.steps) io.stdout(`step       ${s.tool} ${s.args.url ?? ""} ${s.outcome}${s.reason ? ` (${s.reason})` : ""}${s.paidCents ? ` paid ${s.paidCents}c` : ""}\n`);
        io.stdout(`decision   ${r.decision}: ${r.rationale}\n`);
        io.stdout(`balance    ${r.balanceBefore}c -> ${r.balanceAfter}c\n`);
        return;
      }
      const p = r.provider;
      io.stdout(`provider   ${p.name ?? "?"} (${p.url ?? "?"})\n`);
      io.stdout(`topic      ${r.topic}\n`);
      r.calls.forEach((c, i) => {
        io.stdout(`call ${i + 1}     ${c.status}  paid ${c.paidCents}c${c.redemptionId ? `  redemption ${c.redemptionId}` : ""}\n`);
        io.stdout(`data       ${JSON.stringify(c.data)}\n`);
      });
      io.stdout(`balance    ${r.balanceBefore}c -> ${r.balanceAfter}c\n`);
      if (r.reserves) {
        const x = r.reserves;
        io.stdout(`reserves   vault ${x.vaultCents}c >= outstanding ${x.outstandingCents}c (${x.ok ? "ok" : "FAILED"})\n`);
      }
    },
    error: (e) => io.stderr(`error: ${e.kind}: ${e.message}\n`),
  };
}

export function jsonReporter(io: { stdout: (s: string) => void; stderr: (s: string) => void }): Reporter {
  return {
    log: (l) => io.stderr(`${l}\n`),
    result: (r) => io.stdout(`${JSON.stringify(r)}\n`),
    error: (e) => io.stdout(`${JSON.stringify({ ok: false, error: e })}\n`),
  };
}
