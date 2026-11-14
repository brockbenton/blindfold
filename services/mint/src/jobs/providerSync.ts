import type { ProviderMeta } from "../config.js";
import { tx, type Db } from "../db.js";
import type { VaultReader } from "../chain/vaultReader.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Mirror ProviderRecord accounts into `providers`, joined with config/providers.json (02-mint.md, Provider sync). */
export async function syncProviders(db: Db, vault: VaultReader, meta: ProviderMeta[]): Promise<void> {
  const { providerCount } = await vault.getConfig();
  const byId = new Map(meta.map((m) => [m.provider_id, m]));
  for (let id = 0; id < providerCount; id++) {
    const rec = await vault.getProvider(id);
    if (!rec) return; // RPC lag, retry on the next sync
    const m = byId.get(id);
    await tx(db, async (c) => {
      await c.query(
        `insert into providers (provider_id, pubkey, payout_token, active, name, url, price_cents, topics, synced_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (provider_id) do update set pubkey = $2, payout_token = $3, active = $4,
           name = $5, url = $6, price_cents = $7, topics = $8, synced_at = now()`,
        [id, hex(rec.cashuPubkey), rec.payoutToken.toBase58(), rec.active, m?.name ?? null, m?.url ?? null, m?.price_cents ?? null, JSON.stringify(m?.topics ?? [])],
      );
      await c.query("insert into provider_balances (provider_id) values ($1) on conflict do nothing", [id]);
    });
  }
}
