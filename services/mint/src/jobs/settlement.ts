// Settlement state machine (02-mint.md, Settlement recovery). Retry safety comes from Config.last_batch_id onchain.
import { BASE_UNITS_PER_CENT, MAX_PAYOUTS_PER_BATCH, type AdminSettleResponse } from "@blindfold/protocol";
import { tx as dbTx, type Db } from "../db.js";
import { MintError } from "../errors.js";
import { ProgramError, type SettlePayout, type SettleSender } from "../chain/settleSender.js";
import type { VaultReader } from "../chain/vaultReader.js";

export interface SettlementDeps {
  db: Db;
  vault: VaultReader;
  sender: SettleSender;
  syncProviders?: () => Promise<void>;
  /** How long one run waits for confirmation before leaving the batch `submitted`. */
  confirmTimeoutMs?: number;
  /** Cents redeemed less than this many seconds ago are not paid in this run. Default 0. */
  holdS?: number;
  /** Each payout is rounded down to a multiple of this; the remainder stays in the balance. Default 1. */
  unitCents?: number;
}

interface StoredPayout {
  provider_id: number;
  payout_token: string;
  amount_cents: number;
  amount_base: string;
}
interface Row {
  id: number;
  batch_id: number;
  status: "pending" | "submitted";
  payouts: StoredPayout[];
  tx_sig: string | null;
  last_valid: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSettlement(deps: SettlementDeps, opts: { sync?: boolean } = {}): Promise<AdminSettleResponse> {
  const lock = await deps.db.connect();
  try {
    const got = await lock.query("select pg_try_advisory_lock(hashtext(current_schema()), 42) as ok");
    if (!got.rows[0].ok) throw new MintError(70010, "a settlement run is already in progress", 409);
    try {
      if (opts.sync && deps.syncProviders) await deps.syncProviders();
      return await run(deps);
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext(current_schema()), 42)");
    }
  } finally {
    lock.release();
  }
}

async function run(d: SettlementDeps): Promise<AdminSettleResponse> {
  // 1. Recover first. One recovery per run: a failed batch is reported, the next run starts fresh.
  const open = await d.db.query<Row>("select id, batch_id, status, payouts, tx_sig, last_valid from settlements where status in ('pending','submitted') order by id limit 1");
  if (open.rows.length) return recover(d, open.rows[0]);

  // 2. Create the batch. Balances are debited here, under the row lock.
  const chain = (await d.vault.getConfig()).lastBatchId;
  const batchId = Number(chain) + 1;
  const row = await dbTx(d.db, async (c) => {
    // Ready = balance minus cents redeemed inside the hold window, rounded down to the payout unit.
    const unit = Math.max(1, Math.floor(d.unitCents ?? 1));
    const r = await c.query<{ provider_id: number; amount: string; payout_token: string }>(
      `select provider_id, amount, payout_token from (
         select b.provider_id, p.payout_token,
                (greatest(b.balance - coalesce((select sum(r.amount) from redemptions r
                   where r.provider_id = b.provider_id and r.created_at > now() - make_interval(secs => $1::int)), 0)::bigint, 0) / $2::bigint) * $2::bigint as amount
           from provider_balances b join providers p using (provider_id)
          where b.balance > 0 and p.active
          for update of b
       ) x where amount > 0
       order by amount desc, provider_id limit ${MAX_PAYOUTS_PER_BATCH}`,
      [Math.max(0, d.holdS ?? 0), unit],
    );
    if (!r.rows.length) return null;
    const payouts: StoredPayout[] = r.rows.map((x) => ({
      provider_id: x.provider_id,
      payout_token: x.payout_token,
      amount_cents: Number(x.amount),
      amount_base: (BigInt(x.amount) * BASE_UNITS_PER_CENT).toString(),
    }));
    for (const p of payouts) {
      await c.query("update provider_balances set balance = balance - $2 where provider_id = $1", [p.provider_id, p.amount_cents]);
    }
    const ins = await c.query<{ id: number }>(
      "insert into settlements (batch_id, status, payouts) values ($1, 'pending', $2) returning id",
      [batchId, JSON.stringify(payouts)],
    );
    return { id: ins.rows[0].id, batch_id: batchId, status: "pending" as const, payouts, tx_sig: null, last_valid: null };
  });
  if (!row) return { batch_id: null };
  return submit(d, row);
}

const result = (row: Row, tx: string): AdminSettleResponse => ({
  batch_id: row.batch_id,
  payouts: row.payouts.map((p) => ({ provider_id: p.provider_id, amount: p.amount_cents })),
  tx,
});

async function markConfirmed(d: SettlementDeps, row: Row, txSig?: string): Promise<AdminSettleResponse> {
  const r = await d.db.query<{ tx_sig: string | null }>(
    "update settlements set status = 'confirmed', tx_sig = coalesce($2, tx_sig), updated_at = now() where id = $1 returning tx_sig",
    [row.id, txSig ?? null],
  );
  return result(row, r.rows[0].tx_sig ?? "");
}

/** Mark failed and give every payout back to its provider balance, in one transaction. */
async function markFailed(d: SettlementDeps, row: Row, error: string): Promise<never> {
  await dbTx(d.db, async (c) => {
    await c.query("update settlements set status = 'failed', error = $2, updated_at = now() where id = $1", [row.id, error.slice(0, 1000)]);
    for (const p of row.payouts) {
      await c.query("update provider_balances set balance = balance + $2 where provider_id = $1", [p.provider_id, p.amount_cents]);
    }
  });
  throw new MintError(70012, `settlement batch ${row.batch_id} failed: ${error}`, 502);
}

async function recover(d: SettlementDeps, row: Row): Promise<AdminSettleResponse> {
  const chain = (await d.vault.getConfig()).lastBatchId;
  if (chain >= BigInt(row.batch_id)) return markConfirmed(d, row); // landed: never resend
  if (row.status === "submitted" && row.tx_sig) {
    const st = await d.sender.confirm(row.tx_sig);
    if (st === "confirmed") return markConfirmed(d, row);
    if (st === "failed") return markFailed(d, row, "transaction failed onchain");
    if (row.last_valid !== null && !(await d.sender.isExpired(row.last_valid))) {
      throw new MintError(70011, `settlement batch ${row.batch_id} is still in flight`, 409);
    }
  }
  return submit(d, row); // never sent, or expired without landing
}

async function submit(d: SettlementDeps, row: Row): Promise<AdminSettleResponse> {
  const payouts: SettlePayout[] = row.payouts.map((p) => ({ providerId: p.provider_id, payoutToken: p.payout_token, amountBase: BigInt(p.amount_base) }));
  let sent: { tx: string; validUntil: number };
  try {
    sent = await d.sender.submit(BigInt(row.batch_id), payouts);
  } catch (e) {
    if (e instanceof ProgramError) {
      if (e.program === "BadBatchId" && (await d.vault.getConfig()).lastBatchId >= BigInt(row.batch_id)) return markConfirmed(d, row);
      return markFailed(d, row, e.program);
    }
    throw e; // transient: the row stays pending and the next run recovers it
  }
  await d.db.query("update settlements set status = 'submitted', tx_sig = $2, last_valid = $3, updated_at = now() where id = $1", [row.id, sent.tx, sent.validUntil]);
  const deadline = Date.now() + (d.confirmTimeoutMs ?? 30_000);
  for (;;) {
    const st = await d.sender.confirm(sent.tx);
    if (st === "confirmed") return markConfirmed(d, row, sent.tx);
    if (st === "failed") return markFailed(d, row, "transaction failed onchain");
    if (Date.now() >= deadline) throw new MintError(70011, `settlement batch ${row.batch_id} submitted, awaiting confirmation`, 409);
    await sleep(Math.max(1, Math.min(400, deadline - Date.now())));
  }
}
