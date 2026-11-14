import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { issue, newKey, redeem, setupMint, sign, type Harness } from "./helpers.js";

let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; });

describe("provider key re-registration", () => {
  it("syncs a re-registered key and later providers while preserving the old balance", async () => {
    h = await setupMint();
    const { pubkey, sk } = newKey();
    h.vault.addProvider({ cashuPubkey: pubkey });
    await h.ctx.tick();
    const proofs = await issue(h, [pubkey], [1]);
    await h.db.query("update provider_balances set balance = 17 where provider_id = 0");
    h.vault.setActive(0, false);
    h.vault.addProvider({ cashuPubkey: pubkey });
    h.vault.addProvider({ cashuPubkey: newKey().pubkey });
    await h.ctx.tick();
    await h.ctx.tick(); // repeated sync is safe
    expect(await redeem(h, sign(proofs, sk))).toMatchObject({ status: 200, json: { provider_id: 1, amount: 1 } });
    const rows = await h.db.query("select provider_id, pubkey, active, balance from providers join provider_balances using (provider_id) order by provider_id");
    expect(rows.rows).toMatchObject([
      { provider_id: 0, pubkey, active: false, balance: 17 },
      { provider_id: 1, pubkey, active: true, balance: 1 },
      { provider_id: 2, active: true, balance: 0 },
    ]);
    // Redemption must map to a single active provider despite historical key reuse.
    expect((await h.db.query("select provider_id from providers where pubkey = $1 and active", [pubkey])).rows)
      .toEqual([{ provider_id: 1 }]);
  });

  it("upgrades the old global uniqueness constraint without allowing duplicate active keys", async () => {
    h = await setupMint();
    const pubkey = newKey().pubkey;
    h.vault.addProvider({ cashuPubkey: pubkey });
    await h.ctx.tick();
    // Recreate the pre-002 database, including an existing provider and balance.
    await h.db.query("drop index providers_active_pubkey");
    await h.db.query("alter table providers add constraint providers_pubkey_key unique (pubkey)");
    await h.db.query("delete from schema_migrations where name = '002_active_provider_keys.sql'");
    expect(await migrate(h.db)).toEqual(["002_active_provider_keys.sql"]);
    expect(await migrate(h.db)).toEqual([]);
    await expect(h.db.query(
      "insert into providers (provider_id, pubkey, payout_token, active) select 1, pubkey, payout_token, true from providers where provider_id = 0",
    )).rejects.toMatchObject({ code: "23505" });
    await h.db.query("update providers set active = false where provider_id = 0");
    await h.db.query("insert into providers (provider_id, pubkey, payout_token, active) select 1, pubkey, payout_token, true from providers where provider_id = 0");
    expect((await h.db.query("select count(*)::int as n from providers where pubkey = $1", [pubkey])).rows[0].n).toBe(2);
    expect((await h.db.query("select balance from provider_balances where provider_id = 0")).rows[0].balance).toBe(0);
  });
});
