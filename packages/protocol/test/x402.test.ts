import { describe, expect, it } from "vitest";
import {
  CashuRequirementsError, SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, cashuExtra, parseCashuRequirements,
} from "../src/index.js";

const PK = "02" + "ab".repeat(32);
const MINT = "http://localhost:3338";
const req = (over: Record<string, unknown> = {}) => ({
  scheme: "blindfold", network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, amount: "50000", payTo: PK,
  extra: { ...cashuExtra({ mintUrl: MINT, providerPubkey: PK }), paymentFlow: "upfront" },
  ...over,
});
const code = (r: ReturnType<typeof req>) => {
  try { parseCashuRequirements(r as never); } catch (e) { return (e as CashuRequirementsError).code; }
  return "none";
};

describe("x402", () => {
  it("cashuExtra shape", () => {
    expect(cashuExtra({ mintUrl: MINT, providerPubkey: PK })).toEqual({
      mints: [MINT], unit: "usd", nut10: { k: "P2PK", d: PK },
    });
  });
  it("parses a valid requirement", () => {
    expect(parseCashuRequirements(req())).toEqual({ cents: 5, mints: [MINT], unit: "usd", providerPubkey: PK });
  });
  it("rejects each bad case", () => {
    expect(code(req({ scheme: "exact" }))).toBe("wrong_scheme");
    expect(code(req({ network: "solana:mainnet" }))).toBe("wrong_network");
    expect(code(req({ amount: "50001" }))).toBe("bad_amount");
    expect(code(req({ amount: "abc" }))).toBe("bad_amount");
    expect(code(req({ amount: "0" }))).toBe("bad_amount");
    expect(code(req({ payTo: "02" + "cd".repeat(32) }))).toBe("pay_to_mismatch");
    expect(code(req({ extra: { ...req().extra, unit: "sat" } }))).toBe("wrong_unit");
    expect(code(req({ extra: { ...req().extra, mints: [] } }))).toBe("missing_mints");
    expect(code(req({ extra: { ...req().extra, mints: undefined } }))).toBe("missing_mints");
    expect(code(req({ extra: { ...req().extra, nut10: undefined } }))).toBe("bad_nut10");
  });
});
