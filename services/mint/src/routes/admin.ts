import { BASE_UNITS_PER_CENT, type AdminReconcileResponse } from "@blindfold/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { MintError } from "../errors.js";
import type { Ctx } from "../ctx.js";
import { SETTLED_SQL } from "./info.js";
import { rawBody } from "./util.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

export function adminRoutes(ctx: Ctx) {
  const app = new Hono();
  const expected = digest(ctx.cfg.MINT_ADMIN_TOKEN);

  const auth = async (c: import("hono").Context, next: () => Promise<void>) => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1]), expected)) return c.json({ detail: "unauthorized" }, 401);
    await next();
  };
  app.use("/v1/blindfold/admin/*", auth);
  app.use("/dev/*", auth);

  app.get("/v1/blindfold/admin/balances", async (c) => {
    const r = await ctx.db.query("select provider_id, balance from provider_balances where balance > 0 order by provider_id");
    return c.json(r.rows);
  });

  app.post("/v1/blindfold/admin/settle", async (c) => c.json(await ctx.settle()));

  // A hint that a deposit just landed (QuickNode Stream). The poll still reads DepositRecord accounts onchain.
  app.post("/v1/blindfold/admin/poll-deposits", async (c) => c.json({ processed: await ctx.pollDeposits() }));

  app.post("/v1/blindfold/admin/log-issuance", async (c) => {
    if (!ctx.syncIssuance) return c.json({ detail: "this mint cannot write the issuance log", code: 0 }, 400);
    return c.json({ result: await ctx.syncIssuance() });
  });

  app.get("/v1/blindfold/admin/reconcile", async (c) => {
    const one = async (sql: string) => (await ctx.db.query(sql)).rows[0].n as number;
    const out: AdminReconcileResponse = {
      vault_balance: Number((await ctx.vault.getVaultBalanceBase()) / BASE_UNITS_PER_CENT),
      deposited: await one("select coalesce(sum(amount_cents), 0) as n from deposits"),
      issued: await one("select coalesce(sum(amount), 0) as n from issued_signatures"),
      redeemed: await one("select coalesce(sum(amount), 0) as n from redemptions"),
      settled: await one(SETTLED_SQL),
    };
    return c.json(out);
  });

  // Dev only: fake-chain hooks (MINT_DEV_FAKE_CHAIN=1). Not mounted otherwise.
  if (ctx.devVault) {
    const v = ctx.devVault;
    app.post("/dev/deposit", async (c) => {
      const b = await rawBody(c);
      if (typeof b.deposit_ref !== "string" || !Number.isInteger(b.amount_cents)) throw new MintError(10000, "deposit_ref and amount_cents required");
      const rec = v.addDeposit({ amountBase: BigInt(b.amount_cents as number) * BASE_UNITS_PER_CENT, depositRef: b.deposit_ref });
      await ctx.tick();
      return c.json({ index: Number(rec.index) });
    });
    app.post("/dev/provider", async (c) => {
      const b = await rawBody(c);
      if (typeof b.cashu_pubkey !== "string") throw new MintError(10000, "cashu_pubkey required");
      const rec = v.addProvider({ cashuPubkey: b.cashu_pubkey, payoutToken: typeof b.payout_token === "string" ? b.payout_token : undefined });
      await ctx.tick();
      return c.json({ provider_id: rec.providerId, payout_token: rec.payoutToken.toBase58() });
    });
    app.post("/dev/active", async (c) => {
      const b = await rawBody(c);
      v.setActive(b.provider_id as number, b.active === true);
      await ctx.tick();
      return c.json({ ok: true });
    });
  }
  return app;
}
