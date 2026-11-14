import { CASHU_UNIT, MAX_DEPOSIT_CENTS } from "@blindfold/protocol";
import { Hono } from "hono";
import { tx } from "../db.js";
import { MintError } from "../errors.js";
import type { Ctx } from "../ctx.js";
import { unixNow } from "./util.js";

export function infoRoutes(ctx: Ctx) {
  const app = new Hono();

  app.get("/v1/info", (c) =>
    c.json({
      name: "Blindfold mint",
      version: "blindfold-mint/0.1.0",
      description: "Cashu mint for Solana USDC deposits with P2PK-locked proofs",
      nuts: {
        4: { methods: [{ method: "solana-usdc", unit: CASHU_UNIT, min_amount: 1, max_amount: MAX_DEPOSIT_CENTS }], disabled: false },
        5: { methods: [], disabled: true },
        7: { supported: true },
        10: { supported: true },
        11: { supported: true },
        12: { supported: true },
        20: { supported: true },
      },
    }),
  );

  const keysetJson = (k: { id: string; unit: string; keys: Record<string, string>; input_fee_ppk: number }) => ({
    id: k.id, unit: k.unit, keys: k.keys, input_fee_ppk: k.input_fee_ppk,
  });

  app.get("/v1/keys", (c) => c.json({ keysets: ctx.keysets.list().filter((k) => k.active).map(keysetJson) }));
  app.get("/v1/keys/:id", (c) => {
    const k = ctx.keysets.get(c.req.param("id"));
    if (!k) throw new MintError(12001, "keyset not known");
    return c.json({ keysets: [keysetJson(k)] });
  });
  app.get("/v1/keysets", (c) =>
    c.json({ keysets: ctx.keysets.list().map((k) => ({ id: k.id, unit: k.unit, active: k.active, input_fee_ppk: k.input_fee_ppk })) }),
  );

  app.post("/v1/checkstate", async (c) => {
    const { Ys } = (await c.req.json().catch(() => ({}))) as { Ys?: unknown };
    if (!Array.isArray(Ys) || !Ys.every((y) => typeof y === "string") || Ys.length > 1000) throw new MintError(10000, "Ys must be an array of hex strings");
    const spent = new Set((await ctx.db.query<{ y: string }>("select y from spent_proofs where y = any($1)", [Ys])).rows.map((r) => r.y));
    return c.json({ states: (Ys as string[]).map((Y) => ({ Y, state: spent.has(Y) ? "SPENT" : "UNSPENT", witness: null })) });
  });

  app.get("/v1/blindfold/providers", async (c) => {
    const r = await ctx.db.query("select * from providers order by provider_id");
    return c.json(r.rows.map((p) => ({
      provider_id: p.provider_id, pubkey: p.pubkey, name: p.name, url: p.url, price_cents: p.price_cents, topics: p.topics, active: p.active,
    })));
  });

  app.get("/v1/blindfold/reserves", async (c) => {
    const out = await tx(ctx.db, async (q) => {
      const issued = (await q.query("select coalesce(sum(amount), 0) as n from issued_signatures")).rows[0].n as number;
      const settled = (await q.query(SETTLED_SQL)).rows[0].n as number;
      return { issued, settled, outstanding: issued - settled, keyset_id: ctx.keysets.activeId, updated_at: unixNow() };
    }, "repeatable read read only");
    return c.json(out);
  });

  return app;
}

/** Cents paid out by confirmed settlements. */
export const SETTLED_SQL =
  "select coalesce(sum((p->>'amount_cents')::bigint), 0) as n from settlements s, jsonb_array_elements(s.payouts) p where s.status = 'confirmed'";
