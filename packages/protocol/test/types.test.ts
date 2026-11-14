import { Amount } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { fromWireProof, toWireProof } from "../src/index.js";

describe("wire proofs", () => {
  const base = { id: "00aa", secret: "s", C: "02" + "11".repeat(32) };
  it("amount becomes a number, object witness a string", () => {
    const w = toWireProof({ ...base, amount: Amount.from(8), witness: { signatures: ["ab"] } });
    expect(w).toEqual({ ...base, amount: 8, witness: '{"signatures":["ab"]}' });
    expect(toWireProof({ ...base, amount: "4" }).amount).toBe(4);
  });
  it("string witness passes through and no witness stays absent", () => {
    expect(toWireProof({ ...base, amount: Amount.from(1), witness: "{}" }).witness).toBe("{}");
    expect("witness" in toWireProof({ ...base, amount: Amount.from(1) })).toBe(false);
  });
  it("round trips", () => {
    const p = fromWireProof({ ...base, amount: 16, witness: "{}" });
    expect(p.amount.toNumber()).toBe(16);
    expect(toWireProof(p)).toEqual({ ...base, amount: 16, witness: "{}" });
  });
  it("rejects unsafe amounts", () => {
    expect(() => toWireProof({ ...base, amount: "99999999999999999999" })).toThrow();
  });
});
