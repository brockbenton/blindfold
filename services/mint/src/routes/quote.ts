import { CASHU_UNIT, MAX_DEPOSIT_CENTS, QUOTE_EXPIRY_S, centsToBaseUnits } from "@blindfold/protocol";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { MintError, uuidv7 } from "../errors.js";
import type { Ctx } from "../ctx.js";
import { HEX66, rawBody, unixNow } from "./util.js";

interface QuoteRow {
  id: string; deposit_ref: string; unit: string; amount: number; pubkey: string; expiry: number;
  amount_paid: number; amount_issued: number; updated_at: Date;
}

export function quoteRoutes(ctx: Ctx) {
  const app = new Hono();

  const json = (q: QuoteRow) => ({
    quote: q.id,
    request: q.deposit_ref,
    unit: q.unit,
    method: "solana-usdc",
    amount: q.amount,
    expiry: q.expiry,
    pubkey: q.pubkey,
    amount_paid: q.amount_paid,
    amount_issued: q.amount_issued,
    updated_at: Math.floor(q.updated_at.getTime() / 1000),
    vault_program: ctx.cfg.VAULT_PROGRAM_ID,
    usdc_mint: ctx.cfg.USDC_MINT,
    amount_base_units: centsToBaseUnits(q.amount).toString(),
  });

  app.post("/v1/mint/quote/solana-usdc", async (c) => {
    const b = await rawBody(c);
    if (b.unit !== CASHU_UNIT) throw new MintError(11013, "unit must be usd");
    const amount = b.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_DEPOSIT_CENTS) {
      throw new MintError(11006, `amount must be an integer in 1..${MAX_DEPOSIT_CENTS}`);
    }
    if (typeof b.pubkey !== "string" || !HEX66.test(b.pubkey)) throw new MintError(20009, "pubkey (33-byte compressed hex) is required");
    const r = await ctx.db.query<QuoteRow>(
      `insert into mint_quotes (id, deposit_ref, unit, amount, pubkey, expiry) values ($1, $2, $3, $4, $5, $6) returning *`,
      [uuidv7(), randomBytes(32).toString("hex"), CASHU_UNIT, amount, b.pubkey.toLowerCase(), unixNow() + QUOTE_EXPIRY_S],
    );
    return c.json(json(r.rows[0]));
  });

  app.get("/v1/mint/quote/solana-usdc/:id", async (c) => {
    const id = c.req.param("id");
    const r = /^[0-9a-f-]{36}$/i.test(id) ? await ctx.db.query<QuoteRow>("select * from mint_quotes where id = $1", [id]) : { rows: [] as QuoteRow[] };
    if (!r.rows.length) throw new MintError(20001, "quote not found", 404);
    return c.json(json(r.rows[0]));
  });

  return app;
}
