import { describe, expect, it } from "vitest";
import {
  OutputData, createBlindSignature, createNewMintKeys, createRandomSecretKey, getPubKeyFromPrivKey, pointFromHex,
} from "@cashu/cashu-ts";
import { buildLockOptions, signerSet, validateBlindfoldLock } from "../src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const pk = () => hex(getPubKeyFromPrivKey(createRandomSecretKey()));
const secretWith = (tags: string[][], data = pk()) =>
  JSON.stringify(["P2PK", { nonce: "ab".repeat(16), data, tags }]);

describe("buildLockOptions", () => {
  it("dedupes, lowercases, sorts", () => {
    const [a, b] = [pk(), pk()].sort();
    const o = buildLockOptions([b.toUpperCase(), a, b]);
    expect(o).toEqual({ pubkey: [a, b], requiredSignatures: 1, sigFlag: "SIG_INPUTS" });
  });
  it("rejects empty and malformed keys", () => {
    expect(() => buildLockOptions([])).toThrow();
    expect(() => buildLockOptions(["02abcd"])).toThrow();
    expect(() => buildLockOptions(["04" + "11".repeat(32)])).toThrow();
    expect(() => buildLockOptions(["zz".repeat(33)])).toThrow();
  });
});

describe("cashu-ts round trip", () => {
  const kp = createNewMintKeys(13, new Uint8Array(32).fill(3), { unit: "usd" });
  const keyset = { id: kp.keysetId, keys: Object.fromEntries(Object.entries(kp.pubKeys).map(([a, k]) => [a, hex(k)])) };
  const issue = (allowlist: string[]) =>
    OutputData.createP2PKData(buildLockOptions(allowlist), 5, keyset).map((od) => {
      const bm = od.blindedMessage;
      const { C_ } = createBlindSignature(pointFromHex(bm.B_), kp.privKeys[String(bm.amount)], bm.id);
      return od.toProof({ id: bm.id, amount: bm.amount, C_: C_.toHex(true) } as never, keyset);
    });

  it("produces secrets that validate with the full signer set", () => {
    const list = [pk(), pk(), pk()];
    const proofs = issue(list);
    expect(proofs.map((p) => p.amount.toNumber()).sort()).toEqual([1, 4]);
    for (const p of proofs) {
      expect([...signerSet(p.secret)].sort()).toEqual([...list].sort());
      const v = validateBlindfoldLock(p.secret);
      expect(v).toEqual({ ok: true, signers: signerSet(p.secret) });
    }
    expect(signerSet(proofs[0].secret)[0]).toBe([...list].sort()[0]);
  });
  it("single provider lock has no extra signers", () => {
    const k = pk();
    const [p] = issue([k]);
    expect(signerSet(p.secret)).toEqual([k]);
    expect(validateBlindfoldLock(p.secret).ok).toBe(true);
  });
});

describe("validateBlindfoldLock", () => {
  const a = pk(), b = pk();
  const good = [["pubkeys", b], ["n_sigs", "1"], ["sigflag", "SIG_INPUTS"]];
  const reason = (s: string) => {
    const v = validateBlindfoldLock(s);
    return v.ok ? "ok" : v.reason;
  };
  it("accepts the canonical lock and a bare lock", () => {
    expect(validateBlindfoldLock(secretWith(good, a))).toEqual({ ok: true, signers: [a, b] });
    expect(validateBlindfoldLock(secretWith([], a))).toEqual({ ok: true, signers: [a] });
  });
  it("rejects locktime, refund, other tags", () => {
    expect(reason(secretWith([...good, ["locktime", "1"]], a))).toMatch(/locktime/);
    expect(reason(secretWith([...good, ["refund", pk()]], a))).toMatch(/refund/);
    expect(reason(secretWith([...good, ["relay", "x"]], a))).toMatch(/not allowed/);
  });
  it("rejects n_sigs 2, SIG_ALL, duplicate tags, duplicate signers", () => {
    expect(reason(secretWith([["pubkeys", b], ["n_sigs", "2"]], a))).toMatch(/n_sigs/);
    expect(reason(secretWith([["pubkeys", b], ["sigflag", "SIG_ALL"]], a))).toMatch(/sigflag/);
    expect(reason(secretWith([["pubkeys", b], ["pubkeys", pk()]], a))).toMatch(/duplicate tag/);
    expect(reason(secretWith([["pubkeys", a]], a))).toMatch(/duplicate signer/);
  });
  it("rejects malformed secrets and non-P2PK", () => {
    expect(reason("not json")).toMatch(/JSON/);
    expect(reason(JSON.stringify(["HTLC", { nonce: "aa", data: "x", tags: [] }]))).toMatch(/P2PK/);
    expect(reason(JSON.stringify(["P2PK", { nonce: "aa", data: "02ab", tags: [] }]))).toMatch(/pubkey/);
    expect(reason(secretWith([["pubkeys", "02ab"]], a))).toMatch(/pubkey/);
    expect(() => signerSet("garbage")).toThrow();
  });
});
