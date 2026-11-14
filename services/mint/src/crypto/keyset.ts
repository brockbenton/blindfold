import { KEYSET_AMOUNTS, KEYSET_INPUT_FEE_PPK, CASHU_UNIT } from "@blindfold/protocol";
import { createNewMintKeys, serializeMintKeys } from "@cashu/cashu-ts";
import { MintError } from "../errors.js";
import type { Db } from "../db.js";

export interface KeysetInfo {
  id: string;
  unit: string;
  active: boolean;
  input_fee_ppk: number;
  keys: Record<string, string>;
}

/** Keyset ids, public keys, and (for the active keyset only) private keys held in memory. */
export class Keysets {
  private constructor(
    private rows: Map<string, KeysetInfo>,
    readonly activeId: string,
    private privKeys: Record<string, Uint8Array>,
  ) {}

  static derive(seedHex: string) {
    const seed = Uint8Array.from(Buffer.from(seedHex, "hex"));
    const kp = createNewMintKeys(KEYSET_AMOUNTS.length as 13, seed, { unit: CASHU_UNIT, input_fee_ppk: KEYSET_INPUT_FEE_PPK });
    return { id: kp.keysetId, keys: serializeMintKeys(kp.pubKeys) as Record<string, string>, privKeys: kp.privKeys };
  }

  /** Boot step 2: insert the derived keyset if missing, fail if it differs from the stored active one. */
  static async load(db: Db, seedHex: string): Promise<Keysets> {
    const d = Keysets.derive(seedHex);
    const active = await db.query<{ id: string }>("select id from keysets where active and unit = $1", [CASHU_UNIT]);
    if (active.rows.length && active.rows[0].id !== d.id) {
      throw new Error(`MINT_SEED derives keyset ${d.id} but the stored active keyset is ${active.rows[0].id}`);
    }
    await db.query(
      "insert into keysets (id, unit, active, input_fee_ppk, pubkeys) values ($1, $2, true, $3, $4) on conflict (id) do nothing",
      [d.id, CASHU_UNIT, KEYSET_INPUT_FEE_PPK, JSON.stringify(d.keys)],
    );
    const rows = new Map<string, KeysetInfo>();
    for (const r of (await db.query("select * from keysets order by created_at, id")).rows) {
      rows.set(r.id, { id: r.id, unit: r.unit, active: r.active, input_fee_ppk: r.input_fee_ppk, keys: r.pubkeys });
    }
    return new Keysets(rows, d.id, d.privKeys);
  }

  list(): KeysetInfo[] {
    return [...this.rows.values()];
  }
  get(id: string): KeysetInfo | undefined {
    return this.rows.get(id);
  }
  /** Private key for (keyset, amount). Only the derived active keyset has keys. */
  priv(id: string, amount: number): Uint8Array | undefined {
    return id === this.activeId ? this.privKeys[String(amount)] : undefined;
  }
  requireKnown(id: string): KeysetInfo {
    const k = this.rows.get(id);
    if (!k) throw new MintError(12001, "keyset not known");
    return k;
  }
}
