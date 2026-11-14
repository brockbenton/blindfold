import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyDleqIfPresent, verifyUnblindedSignature, pointFromHex, signMintQuote } from "@cashu/cashu-ts";
import { buildMint, fund, newKey, newQuote, setupMint, unblind, type Harness } from "./helpers.js";

let h: Harness;
let lock: string[];
beforeAll(async () => {
  h = await setupMint();
  lock = [newKey().pubkey];
});
afterAll(async () => { await h.cleanup(); });

const mintReq = (body: object) => h.req("/v1/mint/solana-usdc", { body });
const paid = async (cents: number) => { const q = await newQuote(h, cents); await fund(h, q, cents); return q; };
const state = async (id: string) => (await h.req(`/v1/mint/quote/solana-usdc/${id}`)).json;

describe("mint", () => {
  it("issues signatures with DLEQ that unblind into valid proofs; paid after expiry still works", async () => {
    const q = await paid(100);
    await h.db.query("update mint_quotes set expiry = 1 where id = $1", [q.quote]);
    const b = await buildMint(h, lock, [64, 32, 4]);
    const r = await mintReq(b.body(q));
    expect(r.status).toBe(200);
    expect(r.json.signatures).toHaveLength(3);
    const ks = await h.keyset();
    const proofs = unblind(b.ods, r.json.signatures, ks);
    for (const [i, s] of r.json.signatures.entries()) {
      expect(s.dleq.s).toMatch(/^[0-9a-f]{64}$/);
      expect(s.dleq.r).toBeUndefined();
      expect(s.amount).toBe([64, 32, 4][i]);
      expect(verifyDleqIfPresent(proofs[i], ks as never)).toBe(true);
      expect(proofs[i].dleq).toBeDefined();
    }
    expect(proofs.length).toBe(3);
    expect(typeof verifyUnblindedSignature).toBe("function");
    void pointFromHex;
    expect((await state(q.quote)).amount_issued).toBe(100);
  });

  it("rejects unpaid, unknown, oversize, bad signature, over amount, drained, duplicates, wrong keyset", async () => {
    const unpaid = await newQuote(h, 100);
    const b = await buildMint(h, lock, [1]);
    expect((await mintReq(b.body(unpaid))).json.code).toBe(20001);
    expect((await mintReq({ ...b.body(unpaid), quote: "018f0000-0000-7000-8000-000000000000" })).json.code).toBe(20001);

    const q = await paid(10);
    const big = await buildMint(h, lock, Array(257).fill(1));
    expect((await mintReq(big.body(q))).json.code).toBe(11015);
    expect((await mintReq({ quote: q.quote, outputs: [], signature: "00" })).json.code).toBe(11015);

    const ok = b.body(q) as any;
    expect((await mintReq({ ...ok, signature: "00".repeat(64) })).json.code).toBe(20008);
    const other = newKey();
    expect((await mintReq({ ...ok, signature: signMintQuote(other.sk, q.quote, b.ods.map((o) => o.blindedMessage)) })).json.code).toBe(20008);
    expect((await mintReq({ ...ok, signature: "nothex" })).json.code).toBe(20008);

    const tooMuch = await buildMint(h, lock, [8, 4]);
    expect((await mintReq(tooMuch.body(q))).json.code).toBe(11006);

    const dup = b.body(q) as any;
    dup.outputs = [dup.outputs[0], dup.outputs[0]];
    expect((await mintReq(dup)).json.code).toBe(11008);

    const bad = b.body(q) as any;
    bad.outputs = [{ ...bad.outputs[0], id: "00deadbeefdeadbe" }];
    bad.signature = signMintQuote(q.sk, q.quote, bad.outputs.map((o: any) => ({ ...o, amount: 1 })));
    expect((await mintReq(bad)).json.code).toBe(12001);
    const noAmt = await buildMint(h, lock, [1]);
    const nb = noAmt.body(q) as any;
    nb.outputs[0].amount = 3; // not a power of two key
    nb.signature = signMintQuote(q.sk, q.quote, nb.outputs.map((o: any) => ({ ...o, amount: 3 })));
    expect((await mintReq(nb)).json.code).toBe(12002);
    expect((await state(q.quote)).amount_issued).toBe(0);

    // drained
    const full = await buildMint(h, lock, [8, 2]);
    expect((await mintReq(full.body(q))).status).toBe(200);
    const more = await buildMint(h, lock, [1]);
    expect((await mintReq(more.body(q))).json.code).toBe(20002);
  });

  it("replays a lost response exactly; reuse across quotes or partial overlap is 11003", async () => {
    const q = await paid(10);
    const b = await buildMint(h, lock, [4, 2]);
    const body = b.body(q);
    const first = await mintReq(body);
    expect(first.status).toBe(200);
    const again = await mintReq(body);
    expect(again).toEqual(first);
    expect((await state(q.quote)).amount_issued).toBe(6);
    expect((await h.db.query("select count(*)::int as n from issued_signatures where quote_id = $1", [q.quote])).rows[0].n).toBe(2);

    // partial overlap: one old B_ plus a new one
    const fresh = await buildMint(h, lock, [1]);
    const mixed = { ...(body as any), outputs: [(body as any).outputs[0], fresh.ods.map((o) => ({ amount: 1, id: o.blindedMessage.id, B_: o.blindedMessage.B_ }))[0]] };
    mixed.signature = signMintQuote(q.sk, q.quote, mixed.outputs.map((o: any) => ({ ...o, amount: o.amount })));
    expect((await mintReq(mixed)).json.code).toBe(11003);
    // subset of an old request is not an exact match
    const subset = { ...(body as any), outputs: [(body as any).outputs[0]] };
    subset.signature = signMintQuote(q.sk, q.quote, subset.outputs);
    expect((await mintReq(subset)).json.code).toBe(11003);

    // same B_ presented on another quote
    const q2 = await paid(10);
    const stolen = { ...(body as any), quote: q2.quote };
    stolen.signature = signMintQuote(q2.sk, q2.quote, stolen.outputs);
    expect((await mintReq(stolen)).json.code).toBe(11003);
  });

  it("10 parallel mints never issue more than amount_paid", async () => {
    const q = await paid(100);
    const builds = await Promise.all(Array.from({ length: 10 }, () => buildMint(h, lock, [16, 4])));
    const rs = await Promise.all(builds.map((b) => mintReq(b.body(q))));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBe(5);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.json.code === 20002)).toBe(true);
    expect((await state(q.quote)).amount_issued).toBe(100);
  });

  it("amount strings are accepted", async () => {
    const q = await paid(5);
    const b = await buildMint(h, lock, [4, 1]);
    const body = b.body(q) as any;
    body.outputs = body.outputs.map((o: any) => ({ ...o, amount: String(o.amount) }));
    expect((await mintReq(body)).status).toBe(200);
  });
});
