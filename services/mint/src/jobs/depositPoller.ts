import { BASE_UNITS_PER_CENT } from "@blindfold/protocol";
import { tx, type Db } from "../db.js";
import type { VaultReader } from "../chain/vaultReader.js";

const CATCH_UP_CHUNK = 50n;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** One poll tick (00 section 6). Returns how many deposit records were processed. */
export async function pollDeposits(db: Db, vault: VaultReader): Promise<number> {
  const { depositCount } = await vault.getConfig();
  const cursor = BigInt((await db.query<{ next_index: number }>("select next_index from deposit_cursor where id = 1")).rows[0].next_index);
  let next = cursor;
  let processed = 0;
  while (next < depositCount) {
    const end = next + CATCH_UP_CHUNK < depositCount ? next + CATCH_UP_CHUNK : depositCount;
    const indices: bigint[] = [];
    for (let i = next; i < end; i++) indices.push(i);
    const records = await vault.getDeposits(indices);
    for (let k = 0; k < records.length; k++) {
      const rec = records[k];
      if (!rec) return processed; // RPC lag: retry next tick
      const i = indices[k];
      if (rec.index !== i) throw new Error(`DepositRecord at ${i} reports index ${rec.index}`);
      await tx(db, async (c) => {
        const cur = BigInt((await c.query("select next_index from deposit_cursor where id = 1 for update")).rows[0].next_index);
        if (cur !== i) return; // another tick advanced past it
        const ref = hex(rec.depositRef);
        const cents = rec.amount / BASE_UNITS_PER_CENT;
        const ins = await c.query(
          `insert into deposits (index, depositor, amount_base, amount_cents, deposit_ref, slot, block_time)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict (index) do nothing`,
          [i.toString(), rec.depositor.toBase58(), rec.amount.toString(), cents.toString(), ref, rec.slot.toString(), rec.timestamp.toString()],
        );
        if (ins.rowCount) {
          const q = await c.query<{ id: string }>("select id from mint_quotes where deposit_ref = $1 for update", [ref]);
          if (q.rows.length) {
            await c.query("update mint_quotes set amount_paid = amount_paid + $2, updated_at = now() where id = $1", [q.rows[0].id, cents.toString()]);
            await c.query("update deposits set quote_id = $2 where index = $1", [i.toString(), q.rows[0].id]);
          }
        }
        await c.query("update deposit_cursor set next_index = $1 where id = 1", [(i + 1n).toString()]);
      });
      processed++;
    }
    next = end;
  }
  return processed;
}
