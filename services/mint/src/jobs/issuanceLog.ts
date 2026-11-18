// Publishes the mint's issuance to the vault's onchain issuance log (02-mint.md, Issuance log).
// The program only lets `issued` grow (by atomic adds) and advances `settled` itself during settle_batch, so
// agents compare the vault balance with a public claim instead of the mint's HTTP report.
import { BASE_UNITS_PER_CENT } from "@blindfold/protocol";
import type { Db } from "../db.js";
import type { IssuanceWriter } from "../chain/settleSender.js";
import type { VaultReader } from "../chain/vaultReader.js";
import { SETTLED_SQL } from "../routes/info.js";

export type IssuanceSyncResult = "initialized" | "logged" | "unchanged" | "deferred" | "pending" | "unsupported";

/** The deployed program predates the issuance log (Anchor's InstructionFallbackNotFound, error 101). */
export function isUnsupported(e: unknown): boolean {
  const logs = (e as { logs?: string[] })?.logs ?? [];
  const text = [...logs, (e as Error)?.message ?? ""].join("\n");
  return /InstructionFallbackNotFound|Fallback functions are not supported|custom program error: 0x65\b/.test(text);
}

/** A preflight (simulation) rejection: the transaction never reached the chain, so its pending record can go. */
function rejectedBeforeSending(e: unknown): boolean {
  return /(?:Transaction )?simulation failed/i.test((e as Error)?.message ?? "");
}

interface State {
  logged_cents: number;
  pending_kind: "init" | "add" | null;
  pending_cents: number | null;
  pending_sig: string | null;
  pending_valid_until: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const one = async (db: Db, sql: string) => Number((await db.query(sql)).rows[0].n);
const inflightSettlement = (db: Db) => one(db, "select count(*) as n from settlements where status in ('pending', 'submitted')");

export interface IssuanceSyncDeps {
  db: Db;
  vault: VaultReader;
  writer: IssuanceWriter;
  /** How long one sync waits for its transaction to confirm before leaving it pending. Default 30 s. */
  confirmTimeoutMs?: number;
}

/**
 * One sync. Resolves a pending transaction first; then creates the log if missing, joins an existing one, or adds
 * this mint's unlogged issuance.
 */
export async function syncIssuanceLog(d: IssuanceSyncDeps): Promise<IssuanceSyncResult> {
  const lock = await d.db.connect();
  try {
    // Use the settlement lock too, so a same-schema payout cannot cross the baseline snapshot.
    if (!(await lock.query("select pg_try_advisory_lock(hashtext(current_schema()), 42) as ok")).rows[0].ok) return "deferred";
    try {
      return await syncLog(d);
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext(current_schema()), 42)");
    }
  } finally {
    lock.release();
  }
}

async function syncLog(d: IssuanceSyncDeps): Promise<IssuanceSyncResult> {
  const { db, vault, writer } = d;
  const load = async () => (await db.query<State>("select * from issuance_log_state where id = 1")).rows[0] as State | undefined;
  let state = await load();

  if (state?.pending_sig) {
    const resolved = await resolvePending(d, state);
    if (resolved === "pending") return "pending";
    state = await load();
  }

  const issuedCents = await one(db, "select coalesce(sum(amount), 0) as n from issued_signatures");
  const log = await vault.getIssuanceLog();

  if (!log) {
    // A batch sent before the log exists cannot add itself to it, so wait until none is in flight; the baseline
    // is then exactly the confirmed settlements.
    if (await inflightSettlement(db)) return "deferred";
    const settledCents = await one(db, SETTLED_SQL);
    return send(d, "init", issuedCents, () => writer.prepareInitIssuanceLog(BigInt(issuedCents) * BASE_UNITS_PER_CENT, BigInt(settledCents) * BASE_UNITS_PER_CENT));
  }

  if (!state) {
    // Another mint created the log. Join it: this mint's earlier settlements are not in the log's settled total,
    // so count them as already logged and add only the net (issued minus settled) from here on.
    if (await inflightSettlement(db)) return "deferred";
    await joinLog(db);
    state = (await load())!;
  }

  const add = issuedCents - state.logged_cents;
  if (add <= 0) return "unchanged";
  return send(d, "add", add, () => writer.prepareLogIssuance(BigInt(add) * BASE_UNITS_PER_CENT));
}

/** Records the signed transaction as pending, sends it, then waits briefly for confirmation. */
async function send(d: IssuanceSyncDeps, kind: "init" | "add", cents: number, prepare: () => Promise<{ sig: string; validUntil: number; send(): Promise<void> }>): Promise<IssuanceSyncResult> {
  const { db } = d;
  const tx = await prepare();
  await db.query(
    `insert into issuance_log_state (id, logged_cents, pending_kind, pending_cents, pending_sig, pending_valid_until)
     values (1, 0, $1, $2, $3, $4)
     on conflict (id) do update set pending_kind = $1, pending_cents = $2, pending_sig = $3, pending_valid_until = $4, updated_at = now()`,
    [kind, cents, tx.sig, tx.validUntil],
  );
  try {
    await tx.send();
  } catch (e) {
    // Rejected in preflight: it never landed. Anything else (a lost response) is resolved from the chain below.
    if (rejectedBeforeSending(e)) {
      await discardAttempt(db, kind, tx.sig);
      if (isUnsupported(e)) return "unsupported";
      throw e;
    }
  }
  const state = (await db.query<State>("select * from issuance_log_state where id = 1")).rows[0];
  const r = await resolvePending(d, state, d.confirmTimeoutMs ?? 30_000);
  if (r === "pending") return "pending";
  if (r === "failed") throw new Error(`issuance log transaction ${tx.sig} failed`);
  return kind === "init" ? "initialized" : "logged";
}

/** Settles a pending record from its signature status. */
async function resolvePending(d: IssuanceSyncDeps, s: State, waitMs = 0): Promise<"confirmed" | "failed" | "pending"> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let status = await d.writer.confirm(s.pending_sig!);
    const expired = status === "pending" && await d.writer.isExpired(s.pending_valid_until!);
    if (expired) status = await d.writer.confirm(s.pending_sig!);
    if (status === "confirmed") {
      // For an init, the log now holds exactly this mint's issuance at the time; for an add, the added cents.
      await d.db.query(
        `update issuance_log_state set logged_cents = case when pending_kind = 'init' then pending_cents else logged_cents + pending_cents end,
         pending_kind = null, pending_cents = null, pending_sig = null, pending_valid_until = null, updated_at = now() where id = 1 and pending_sig = $1`,
        [s.pending_sig],
      );
      return "confirmed";
    }
    if (status === "failed" || expired) {
      await discardAttempt(d.db, s.pending_kind!, s.pending_sig!);
      return "failed";
    }
    if (Date.now() >= deadline) return "pending";
    await sleep(500);
  }
}

function discardAttempt(db: Db, kind: "init" | "add", sig: string) {
  // If another mint won initialization, the next run must join its log with a fresh baseline.
  return kind === "init"
    ? db.query("delete from issuance_log_state where id = 1 and pending_sig = $1", [sig])
    : db.query("update issuance_log_state set pending_kind = null, pending_cents = null, pending_sig = null, pending_valid_until = null, updated_at = now() where id = 1 and pending_sig = $1", [sig]);
}

async function joinLog(db: Db): Promise<void> {
  const unloggedSettlements = await one(db, SETTLED_SQL + " and s.issuance_accounted = false");
  await db.query("insert into issuance_log_state (id, logged_cents) values (1, $1) on conflict (id) do nothing", [unloggedSettlements]);
}
