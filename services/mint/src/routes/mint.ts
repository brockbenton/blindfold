import { MAX_MINT_OUTPUTS } from "@blindfold/protocol";
import { Amount, verifyMintQuoteSignature } from "@cashu/cashu-ts";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { signOutput, type SignedOutput } from "../crypto/blind.js";
import { isUniqueViolation, tx } from "../db.js";
import { MintError } from "../errors.js";
import type { Ctx } from "../ctx.js";
import { HEX66, UUID, rawBody } from "./util.js";

const output = z.object({
  amount: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().safe()),
  id: z.string(),
  B_: z.string().regex(HEX66),
});
const head = z.object({ quote: z.string(), signature: z.string() });

interface SigRow { b_: string; amount: number; keyset_id: string; c_: string; dleq_s: string; dleq_e: string; quote_id: string; request_id: string }
const toSigned = (r: SigRow): SignedOutput => ({ amount: r.amount, id: r.keyset_id, C_: r.c_, dleq: { s: r.dleq_s, e: r.dleq_e } });

export function mintRoutes(ctx: Ctx) {
  const app = new Hono();

  app.post("/v1/mint/solana-usdc", async (c) => {
    const b = await rawBody(c);
    const h = head.safeParse(b);
    if (!h.success) throw new MintError(10000, "quote and signature are required strings");
    if (!Array.isArray(b.outputs)) throw new MintError(10000, "outputs must be an array");
    if (b.outputs.length < 1 || b.outputs.length > MAX_MINT_OUTPUTS) throw new MintError(11015, `outputs must be 1..${MAX_MINT_OUTPUTS}`);
    const parsed = z.array(output).safeParse(b.outputs);
    if (!parsed.success) throw new MintError(10000, "malformed output");
    const outputs = parsed.data.map((o) => ({ ...o, B_: o.B_.toLowerCase() }));
    const bs = outputs.map((o) => o.B_);
    if (new Set(bs).size !== bs.length) throw new MintError(11008, "duplicate outputs");
    const { quote: quoteId, signature } = h.data;
    const total = outputs.reduce((s, o) => s + o.amount, 0);
    const isUuid = UUID.test(quoteId);

    const signatures = await tx(ctx.db, async (c) => {
      const q = isUuid ? (await c.query("select * from mint_quotes where id = $1 for update", [quoteId])).rows[0] : undefined;
      if (!q || q.amount_paid === 0) throw new MintError(20001, "quote not found or not paid");

      let ok = false;
      try {
        ok = verifyMintQuoteSignature(q.pubkey, q.id, outputs.map((o) => ({ amount: Amount.from(o.amount), id: o.id, B_: o.B_ })), signature);
      } catch { /* malformed signature */ }
      if (!ok) throw new MintError(20008, "invalid NUT-20 signature");

      // Replay of a lost response: the exact same set, already signed for this quote.
      const prev = (await c.query<SigRow>("select * from issued_signatures where b_ = any($1)", [bs])).rows;
      if (prev.length) {
        const reqIds = new Set(prev.map((r) => r.request_id));
        const sameQuote = prev.every((r) => r.quote_id === q.id);
        if (sameQuote && reqIds.size === 1 && prev.length === bs.length) {
          const n = (await c.query("select count(*)::int as n from issued_signatures where request_id = $1", [[...reqIds][0]])).rows[0].n;
          if (n === bs.length) {
            const by = new Map(prev.map((r) => [r.b_, r]));
            return bs.map((B) => toSigned(by.get(B)!));
          }
        }
        throw new MintError(11003, "outputs have already been signed");
      }

      const mintable = q.amount_paid - q.amount_issued;
      if (mintable <= 0) throw new MintError(20002, "nothing left to mint on this quote");
      if (total > mintable) throw new MintError(11006, `outputs total ${total} exceeds mintable ${mintable}`);

      const ks = ctx.keysets;
      for (const o of outputs) {
        if (o.id !== ks.activeId) throw new MintError(12001, "keyset not known or not active");
        if (!ks.priv(o.id, o.amount)) throw new MintError(12002, "amount not in keyset");
      }
      let signed: SignedOutput[];
      try {
        signed = outputs.map((o) => signOutput(o.B_, o.amount, o.id, ks.priv(o.id, o.amount)!));
      } catch {
        throw new MintError(10000, "invalid blinded message");
      }

      const requestId = randomUUID();
      try {
        for (let i = 0; i < signed.length; i++) {
          const s = signed[i];
          await c.query(
            "insert into issued_signatures (b_, quote_id, request_id, seq, keyset_id, amount, c_, dleq_s, dleq_e) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [outputs[i].B_, q.id, requestId, i, s.id, s.amount, s.C_, s.dleq.s, s.dleq.e],
          );
        }
      } catch (e) {
        if (isUniqueViolation(e)) throw new MintError(11003, "outputs have already been signed");
        throw e;
      }
      await c.query("update mint_quotes set amount_issued = amount_issued + $2, updated_at = now() where id = $1", [q.id, total]);
      return signed;
    });
    return c.json({ signatures });
  });

  return app;
}
