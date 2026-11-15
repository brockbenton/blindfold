import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signP2PKProofs } from "@cashu/cashu-ts";
import { toWireProof } from "@blindfold/protocol";
import { addProvider, balances, buildMint, fund, issue, newKey, newQuote, redeem, setupMint, sign, unblind, type Harness } from "./helpers.js";

let h: Harness;
let A: Awaited<ReturnType<typeof addProvider>>, B: Awaited<ReturnType<typeof addProvider>>;
beforeAll(async () => {
  h = await setupMint();
  A = await addProvider(h);
  B = await addProvider(h);
});
afterAll(async () => { await h.cleanup(); });

const bal = async () => balances(h);
const ys = async (proofs: any[]) => {
  const { proofY } = await import("../src/crypto/p2pk.js");
  return proofs.map((p) => proofY(p.secret));
};

describe("redeem happy path", () => {
  it("N=1 lock credits the signer", async () => {
    const proofs = await issue(h, [A.pubkey], [4, 1]);
    const r = await redeem(h, sign(proofs, A.sk));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ provider_id: A.id, amount: 5 });
    expect(r.json.redemption_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await bal())[A.id]).toBe(5);
  });

  it("N=3 allowlist: each signer key credits its own provider", async () => {
    const C = await addProvider(h);
    const before = await bal();
    const proofs = await issue(h, [A.pubkey, B.pubkey, C.pubkey], [8, 2, 1]);
    expect((await redeem(h, sign([proofs[0]], B.sk))).json).toMatchObject({ provider_id: B.id, amount: 8 });
    expect((await redeem(h, sign([proofs[1]], C.sk))).json).toMatchObject({ provider_id: C.id, amount: 2 });
    expect((await redeem(h, sign([proofs[2]], A.sk))).json).toMatchObject({ provider_id: A.id, amount: 1 });
    const after = await bal();
    expect(after[B.id] - (before[B.id] ?? 0)).toBe(8);
    expect(after[C.id]).toBe(2);
    expect(after[A.id] - (before[A.id] ?? 0)).toBe(1);
  });

  it("accepts amount as a numeric string and the witness as an object", async () => {
    const proofs = await issue(h, [A.pubkey], [2]);
    const signed = sign(proofs, A.sk)[0];
    expect(typeof signed.witness).toBe("object");
    const wire = { amount: "2", id: signed.id, secret: signed.secret, C: signed.C, witness: signed.witness };
    const r = await h.req("/v1/blindfold/redeem", { body: { proofs: [wire] } });
    expect(r.status).toBe(200);
    expect(r.json.amount).toBe(2);
  });

  it("checkstate: UNSPENT before, SPENT after", async () => {
    const proofs = await issue(h, [A.pubkey], [1]);
    const Y = await ys(proofs);
    const pre = await h.req("/v1/checkstate", { body: { Ys: Y } });
    expect(pre.json.states).toEqual([{ Y: Y[0], state: "UNSPENT", witness: null }]);
    await redeem(h, sign(proofs, A.sk));
    expect((await h.req("/v1/checkstate", { body: { Ys: Y } })).json.states[0].state).toBe("SPENT");
  });
});

describe("redeem rejections", () => {
  it("forged C is 10001", async () => {
    const [p, q] = await issue(h, [A.pubkey], [2, 1]);
    const forged = { ...p, C: q.C };
    expect((await redeem(h, sign([forged], A.sk))).json.code).toBe(10001);
  });

  it("non-P2PK secret is 70001", async () => {
    const q = await newQuote(h, 2);
    await fund(h, q, 2);
    const b = await buildMint(h, "random", [2]);
    const r = await h.req("/v1/mint/solana-usdc", { body: b.body(q) });
    const proofs = unblind(b.ods, r.json.signatures, await h.keyset());
    expect((await redeem(h, proofs)).json.code).toBe(70001);
  });

  it("SIG_ALL, locktime and refund locks are 70001", async () => {
    const opts = [
      { pubkey: [A.pubkey], sigFlag: "SIG_ALL" as const },
      { pubkey: [A.pubkey], locktime: Math.floor(Date.now() / 1000) + 10_000 },
      { pubkey: [A.pubkey], locktime: Math.floor(Date.now() / 1000) + 10_000, refundKeys: [newKey().pubkey] },
      { pubkey: [A.pubkey], requiredSignatures: 1, additionalTags: [["custom", "x"]] as [string, string][] },
    ];
    for (const o of opts) {
      const proofs = await issue(h, o, [1]);
      const r = await redeem(h, proofs);
      expect(r.json.code, JSON.stringify(o)).toBe(70001);
    }
  });

  it("no witness is 10001; two valid signers is 10001; garbage witness is 10001", async () => {
    const [p, q] = await issue(h, [A.pubkey, B.pubkey], [2, 1]);
    expect((await redeem(h, [p])).json.code).toBe(10001);
    const both = signP2PKProofs(sign([p], A.sk), B.sk);
    const sigs = (JSON.parse(typeof both[0].witness === "string" ? both[0].witness : JSON.stringify(both[0].witness)) as { signatures: string[] }).signatures;
    expect(sigs.length).toBe(2);
    expect((await redeem(h, both)).json.code).toBe(10001);
    const wire = { ...toWireProof(q), witness: "not json" };
    expect((await h.req("/v1/blindfold/redeem", { body: { proofs: [wire] } })).json.code).toBe(10001);
    // signature from a key outside the lock
    const stranger = newKey();
    expect((await redeem(h, sign([q], stranger.sk))).json.code).toBe(10001);
  });

  it("unregistered key is 70002; deactivated key is 70002 after sync", async () => {
    const X = newKey();
    const [p] = await issue(h, [X.pubkey], [1]);
    expect((await redeem(h, sign([p], X.sk))).json.code).toBe(70002);

    const D = await addProvider(h);
    const [d, d2] = await issue(h, [D.pubkey], [1, 2]);
    expect((await redeem(h, sign([d], D.sk))).status).toBe(200);
    h.vault.setActive(D.id, false);
    await h.ctx.tick();
    expect((await redeem(h, sign([d2], D.sk))).json.code).toBe(70002);
    // it stays unspent
    expect((await h.req("/v1/checkstate", { body: { Ys: await ys([d2]) } })).json.states[0].state).toBe("UNSPENT");
  });

  it("a deactivated key re-registered as a new record redeems to the new provider id", async () => {
    const R = await addProvider(h);
    h.vault.setActive(R.id, false);
    const rec = h.vault.addProvider({ cashuPubkey: R.pubkey });
    await h.ctx.tick();
    const list = (await h.req("/v1/blindfold/providers")).json as any[];
    expect(list.find((p) => p.provider_id === R.id).active).toBe(false);
    expect(list.find((p) => p.provider_id === rec.providerId).active).toBe(true);
    const [p] = await issue(h, [R.pubkey], [1]);
    const r = await redeem(h, sign([p], R.sk));
    expect(r.status).toBe(200);
    expect(r.json.provider_id).toBe(rec.providerId);
  });

  it("a duplicate active key is cached inactive and does not block later providers", async () => {
    const K = await addProvider(h);
    const dup = h.vault.addProvider({ cashuPubkey: K.pubkey });
    const later = newKey();
    const laterRec = h.vault.addProvider({ cashuPubkey: later.pubkey });
    await h.ctx.tick();
    const list = (await h.req("/v1/blindfold/providers")).json as any[];
    expect(list.find((p) => p.provider_id === K.id).active).toBe(true);
    expect(list.find((p) => p.provider_id === dup.providerId).active).toBe(false);
    expect(list.find((p) => p.provider_id === laterRec.providerId)).toMatchObject({ pubkey: later.pubkey, active: true });
    const [p] = await issue(h, [K.pubkey], [1]);
    expect((await redeem(h, sign([p], K.sk))).json.provider_id).toBe(K.id);
  });

  it("two providers in one request is 70003 and nothing is spent", async () => {
    const [p, q] = await issue(h, [A.pubkey, B.pubkey], [2, 1]);
    const mixed = [...sign([p], A.sk), ...sign([q], B.sk)];
    expect((await redeem(h, mixed)).json.code).toBe(70003);
    expect((await h.req("/v1/checkstate", { body: { Ys: await ys([p, q]) } })).json.states.map((s: any) => s.state)).toEqual(["UNSPENT", "UNSPENT"]);
  });

  it("duplicate secret is 11007; 0 and 65 proofs are 11014", async () => {
    const [p] = await issue(h, [A.pubkey], [1]);
    const s = sign([p], A.sk)[0];
    expect((await redeem(h, [s, s])).json.code).toBe(11007);
    const dummy = { amount: 1, id: s.id, secret: "x", C: s.C };
    expect((await h.req("/v1/blindfold/redeem", { body: { proofs: Array(65).fill(dummy) } })).json.code).toBe(11014);
    expect((await h.req("/v1/blindfold/redeem", { body: { proofs: [] } })).json.code).toBe(11014);
  });

  it("unknown keyset is 12001, malformed body is 10000", async () => {
    const [p] = await issue(h, [A.pubkey], [1]);
    const s = sign([p], A.sk)[0];
    expect((await redeem(h, [{ ...s, id: "00aabbccddeeff00" }])).json.code).toBe(12001);
    expect((await h.req("/v1/blindfold/redeem", { body: { proofs: [{ amount: 1 }] } })).json.code).toBe(10000);
    expect((await h.req("/v1/blindfold/redeem", { body: { nope: 1 } })).json.code).toBe(11014);
  });
});

describe("double spend", () => {
  it("same proof in two parallel redeems: exactly one succeeds, credited once", async () => {
    const proofs = await issue(h, [A.pubkey], [4]);
    const signed = sign(proofs, A.sk);
    const before = (await bal())[A.id] ?? 0;
    const rs = await Promise.all(Array.from({ length: 6 }, () => redeem(h, signed)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.json.code === 11001)).toBe(true);
    expect((await bal())[A.id]).toBe(before + 4);
  });

  it("a request with one spent and one fresh proof leaves the fresh one unspent", async () => {
    const [p, q] = await issue(h, [A.pubkey], [2, 1]);
    expect((await redeem(h, sign([p], A.sk))).status).toBe(200);
    const before = (await bal())[A.id];
    expect((await redeem(h, sign([p, q], A.sk))).json.code).toBe(11001);
    expect((await h.req("/v1/checkstate", { body: { Ys: await ys([q]) } })).json.states[0].state).toBe("UNSPENT");
    expect((await bal())[A.id]).toBe(before);
    expect((await redeem(h, sign([q], A.sk))).status).toBe(200);
  });
});

