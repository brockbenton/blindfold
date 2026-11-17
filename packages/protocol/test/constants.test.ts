import { describe, expect, it } from "vitest";
import * as p from "../src/index.js";

describe("constants", () => {
  it("matches section 2", () => {
    expect(p.KEYSET_AMOUNTS).toHaveLength(13);
    expect(p.KEYSET_AMOUNTS[0]).toBe(1);
    expect(p.KEYSET_AMOUNTS[12]).toBe(4096);
    expect(p.BASE_UNITS_PER_CENT).toBe(10_000n);
    expect(p.MAX_DEPOSIT_CENTS).toBe(5000);
    expect(p.MAX_PAYOUTS_PER_BATCH).toBe(8);
    expect(p.X402_VERSION).toBe(2);
    expect(p.BLINDFOLD_SCHEME).toBe("blindfold");
    expect(p.SOLANA_DEVNET_CAIP2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(p.SOLANA_COMMITMENT).toBe("confirmed");
  });
  it("has the error codes", () => {
    expect(p.ErrorCode.PROOF_ALREADY_SPENT).toBe(11001);
    expect(p.ErrorCode.INVALID_LOCK).toBe(70001);
    expect(p.ErrorCode.MIXED_PROVIDERS).toBe(70003);
    expect(p.redeemFailedReason(11001)).toBe("redeem_failed_11001");
  });
});
