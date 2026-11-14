import { describe, expect, it } from "vitest";
import { createTestKeyset, issueLockedProofs, makeProviderKey } from "@blindfold/testkit";
import { toWireProof, type WireProof } from "@blindfold/protocol";
import { selectExact } from "../src/select.js";

const a = makeProviderKey(), b = makeProviderKey(), c = makeProviderKey();
const keyset = createTestKeyset();
const wire = (amounts: number[], allow = [a.pubkey, b.pubkey]): WireProof[] =>
  issueLockedProofs({ keyset, allowlist: allow, amounts }).map((p) => toWireProof(p));
const amts = (r: { chosen: WireProof[] } | { error: string }) => ("chosen" in r ? r.chosen.map((p) => p.amount).sort((x, y) => y - x) : r.error);

describe("selectExact", () => {
  it("picks 4+1 for 5 from [4,1,1,2,8]", () => {
    expect(amts(selectExact(wire([4, 1, 1, 2, 8]), 5, a.pubkey))).toEqual([4, 1]);
  });
  it("is deterministic under shuffling", () => {
    const ps = wire([4, 1, 1, 2, 8, 1, 4, 2]);
    const base = selectExact(ps, 5, a.pubkey) as { chosen: WireProof[] };
    for (let i = 0; i < 20; i++) {
      const shuffled = [...ps].sort(() => Math.random() - 0.5);
      const r = selectExact(shuffled, 5, a.pubkey) as { chosen: WireProof[] };
      expect(r.chosen.map((p) => p.secret)).toEqual(base.chosen.map((p) => p.secret));
    }
  });
  it("insufficient_exact when no subset matches", () => {
    expect(selectExact(wire([4, 4]), 7, a.pubkey)).toEqual({ error: "insufficient_exact" });
  });
  it("insufficient_balance when the total is too small", () => {
    expect(selectExact(wire([1, 2]), 5, a.pubkey)).toEqual({ error: "insufficient_balance" });
    expect(selectExact([], 5, a.pubkey)).toEqual({ error: "insufficient_balance" });
  });
  it("provider_not_in_signer_set for proofs locked to other keys", () => {
    expect(selectExact(wire([4, 1, 8], [a.pubkey, b.pubkey]), 5, c.pubkey)).toEqual({ error: "provider_not_in_signer_set" });
  });
  it("ignores proofs not locked to the provider", () => {
    const mixed = [...wire([4, 1], [b.pubkey]), ...wire([2, 2, 1], [a.pubkey])];
    expect(amts(selectExact(mixed, 5, a.pubkey))).toEqual([2, 2, 1]);
  });
});
