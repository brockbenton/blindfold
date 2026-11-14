import { describe, expect, it } from "vitest";
import { baseUnitsToCents, centsToBaseUnits } from "../src/index.js";

describe("units", () => {
  it("converts cents to base units", () => {
    expect(centsToBaseUnits(5)).toBe(50_000n);
    expect(centsToBaseUnits(5000n)).toBe(50_000_000n);
    expect(centsToBaseUnits(0)).toBe(0n);
  });
  it("rejects bad cents", () => {
    expect(() => centsToBaseUnits(1.5)).toThrow();
    expect(() => centsToBaseUnits(-1)).toThrow();
    expect(() => centsToBaseUnits(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
  it("converts base units to cents", () => {
    expect(baseUnitsToCents(50_000n)).toBe(5);
    expect(baseUnitsToCents("50000")).toBe(5);
    expect(baseUnitsToCents(0n)).toBe(0);
  });
  it("throws on fractional cents, negatives, junk and unsafe values", () => {
    expect(() => baseUnitsToCents(50_001n)).toThrow(/whole/);
    expect(() => baseUnitsToCents("5000.0")).toThrow();
    expect(() => baseUnitsToCents("-10000")).toThrow();
    expect(() => baseUnitsToCents(-10_000n)).toThrow();
    expect(() => baseUnitsToCents("")).toThrow();
    expect(() => baseUnitsToCents((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 10_000n)).toThrow(/safe/);
  });
});
