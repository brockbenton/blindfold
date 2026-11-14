import { BlindfoldErrorCode, CashuErrorCode, MAX_REDEEM_PROOFS } from "@blindfold/protocol";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { verifyLockedProof, type NormalProof } from "../crypto/p2pk.js";
import { isUniqueViolation, tx } from "../db.js";
import { MintError } from "../errors.js";
import type { Ctx } from "../ctx.js";
import { rawBody } from "./util.js";

// Wire form (00 3.4) is amount number + witness string; also accept amount string and object witness (cashu-ts v4).
const proofSchema = z.object({
  amount: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().positive().safe()),
  id: z.string(),
  secret: z.string(),
  C: z.string(),
  witness: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
});

export function redeemRoutes(ctx: Ctx) {
  const app = new Hono();

  app.post("/v1/blindfold/redeem", async (c) => {
    const b = await rawBody(c);
    if (!Array.isArray(b.proofs) || b.proofs.length < 1 || b.proofs.length > MAX_REDEEM_PROOFS) {
      throw new MintError(CashuErrorCode.TOO_MANY_INPUTS, `proofs must be 1..${MAX_REDEEM_PROOFS}`);
    }
    const parsed = z.array(proofSchema).safeParse(b.proofs);
    if (!parsed.success) throw new MintError(10000, "malformed proof");
    const proofs: NormalProof[] = parsed.data.map((p) => ({ ...p, witness: p.witness ?? undefined }));
    if (new Set(proofs.map((p) => p.secret)).size !== proofs.length) throw new MintError(CashuErrorCode.DUPLICATE_INPUTS, "duplicate secret");

    // Checks 2 to 5, no locks held.
    const checked = proofs.map((p) => ({ p, ...verifyLockedProof(p, ctx.keysets) }));

    // Check 6: the key that signed must be an active registered provider. The credited provider comes only from here.
    const signers = [...new Set(checked.map((x) => x.signer))];
    const found = await ctx.db.query<{ provider_id: number; pubkey: string }>("select provider_id, pubkey from providers where pubkey = any($1) and active", [signers]);
    const byKey = new Map(found.rows.map((r) => [r.pubkey, r.provider_id]));
    if (signers.some((s) => !byKey.has(s))) throw new MintError(BlindfoldErrorCode.PROVIDER_NOT_REGISTERED, "signer is not an active registered provider");
    // Check 7.
    if (signers.length !== 1) throw new MintError(BlindfoldErrorCode.MIXED_PROVIDERS, "proofs were signed by different providers");
    const providerId = byKey.get(signers[0])!;
    const sum = proofs.reduce((s, p) => s + p.amount, 0);
    const redemptionId = randomUUID();

    // Check 8: one transaction. A Y already present aborts everything.
    try {
      await tx(ctx.db, async (q) => {
        await q.query("insert into redemptions (id, provider_id, amount, proof_count) values ($1, $2, $3, $4)", [redemptionId, providerId, sum, proofs.length]);
        const vals: unknown[] = [];
        const rows = checked.map((x, i) => {
          vals.push(x.y, x.p.amount, x.p.id);
          return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3}, '${redemptionId}')`;
        });
        await q.query(`insert into spent_proofs (y, amount, keyset_id, redemption_id) values ${rows.join(",")}`, vals);
        await q.query(
          "insert into provider_balances (provider_id, balance) values ($1, $2) on conflict (provider_id) do update set balance = provider_balances.balance + $2",
          [providerId, sum],
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new MintError(CashuErrorCode.PROOF_ALREADY_SPENT, "proof already spent");
      throw e;
    }
    return c.json({ provider_id: providerId, amount: sum, redemption_id: redemptionId });
  });

  return app;
}
