import { describe, expect, it } from "vitest";
import { BlindfoldErrorCode, CashuErrorCode, signerSet, toWireProof } from "@blindfold/protocol";
import { createTestKeyset, fakeRedeem, issueLockedProofs, makeProviderKey, signAsProvider } from "../src/index.js";

const setup = () => {
  const keyset = createTestKeyset();
  const a = makeProviderKey(), b = makeProviderKey();
  const proofs = issueLockedProofs({ keyset, allowlist: [a.pubkey, b.pubkey], amounts: [4, 1, 1, 2] });
  return { keyset, a, b, proofs };
};

describe("keyset and issuance", () => {
  it("is deterministic per seed", () => {
    expect(createTestKeyset(1).id).toBe(createTestKeyset(1).id);
    expect(createTestKeyset(1).id).not.toBe(createTestKeyset(2).id);
    expect(Object.keys(createTestKeyset().keys)).toHaveLength(13);
  });
  it("issues the exact split locked to the allowlist", () => {
    const { proofs, a, b } = setup();
    expect(proofs.map((p) => p.amount.toNumber()).sort()).toEqual([1, 1, 2, 4]);
    for (const p of proofs) expect([...signerSet(p.secret)].sort()).toEqual([a.pubkey, b.pubkey].sort());
  });
});

describe("fakeRedeem", () => {
  it("redeems provider-signed proofs and credits the signer", () => {
    const { keyset, b, a, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey, b.pubkey]);
    const r = m.redeem(signAsProvider(proofs.slice(0, 2), b.sk));
    expect(r).toMatchObject({ ok: true, provider_id: 1 });
    expect(m.balances.get(1)).toBe(proofs.slice(0, 2).reduce((s, p) => s + p.amount.toNumber(), 0));
  });
  it("accepts wire-form proofs", () => {
    const { keyset, a, proofs } = setup();
    const m = fakeRedeem(keyset, new Map([[a.pubkey, 9]]));
    const r = m.redeem(signAsProvider([proofs[0]], a.sk).map(toWireProof));
    expect(r).toMatchObject({ ok: true, provider_id: 9 });
  });
  it("rejects replay with 11001 and keeps balances", () => {
    const { keyset, a, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey]);
    const signed = signAsProvider([proofs[0]], a.sk);
    expect(m.redeem(signed).ok).toBe(true);
    expect(m.redeem(signed)).toMatchObject({ ok: false, code: CashuErrorCode.PROOF_ALREADY_SPENT });
    expect(m.balances.get(0)).toBe(proofs[0].amount.toNumber());
  });
  it("replay inside a mixed request aborts everything", () => {
    const { keyset, a, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey]);
    m.redeem(signAsProvider([proofs[0]], a.sk));
    const before = m.spent.size;
    const r = m.redeem(signAsProvider([proofs[0], proofs[1]], a.sk));
    expect(r).toMatchObject({ ok: false, code: 11001 });
    expect(m.spent.size).toBe(before);
  });
  it("rejects unsigned, unregistered signer, outsider signer", () => {
    const { keyset, a, b, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey]);
    expect(m.redeem([proofs[0]])).toMatchObject({ ok: false, code: CashuErrorCode.TOKEN_NOT_VERIFIED });
    expect(m.redeem(signAsProvider([proofs[0]], b.sk))).toMatchObject({ ok: false, code: BlindfoldErrorCode.PROVIDER_NOT_REGISTERED });
    const outsider = makeProviderKey();
    expect(m.redeem(signAsProvider([proofs[0]], outsider.sk))).toMatchObject({ ok: false, code: CashuErrorCode.TOKEN_NOT_VERIFIED });
  });
  it("rejects duplicates, unknown keyset and tampered C", () => {
    const { keyset, a, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey]);
    const s = signAsProvider([proofs[0]], a.sk)[0];
    expect(m.redeem([s, s])).toMatchObject({ code: CashuErrorCode.DUPLICATE_INPUTS });
    expect(m.redeem([{ ...s, id: "00ffffffffffffff" }])).toMatchObject({ code: CashuErrorCode.KEYSET_NOT_FOUND });
    expect(m.redeem([{ ...s, C: proofs[1].C }])).toMatchObject({ code: CashuErrorCode.TOKEN_NOT_VERIFIED });
    expect(m.redeem([])).toMatchObject({ code: CashuErrorCode.TOO_MANY_INPUTS });
  });
  it("rejects mixed providers (both in the lock, both registered)", () => {
    const { keyset, a, b, proofs } = setup();
    const m = fakeRedeem(keyset, [a.pubkey, b.pubkey]);
    const mixed = [signAsProvider([proofs[0]], a.sk)[0], signAsProvider([proofs[1]], b.sk)[0]];
    expect(m.redeem(mixed)).toMatchObject({ ok: false, code: BlindfoldErrorCode.MIXED_PROVIDERS });
  });
  it("rejects a proof whose C does not match its secret", () => {
    const { keyset, a } = setup();
    const m = fakeRedeem(keyset, [a.pubkey]);
    const bad = issueLockedProofs({ keyset, allowlist: [a.pubkey], amounts: [1] })[0];
    // A valid C for a different secret is rejected earlier (10001); an unlocked secret needs its own signature.
    expect(m.redeem([{ ...bad, secret: "plain-secret" }])).toMatchObject({ ok: false, code: CashuErrorCode.TOKEN_NOT_VERIFIED });
  });
});
