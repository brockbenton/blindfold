import { BASE_UNITS_PER_CENT } from "./constants.js";

/** Cents (integer) to USDC base units (6 decimals). */
export function centsToBaseUnits(cents: number | bigint): bigint {
  if (typeof cents === "number" && !Number.isSafeInteger(cents)) {
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  }
  const c = BigInt(cents);
  if (c < 0n) throw new RangeError("cents must not be negative");
  return c * BASE_UNITS_PER_CENT;
}

/** USDC base units to cents. Throws unless the value is a whole number of cents that fits a safe integer. */
export function baseUnitsToCents(base: bigint | string): number {
  let b: bigint;
  if (typeof base === "string") {
    if (!/^\d+$/.test(base)) throw new RangeError(`base units must be a non-negative integer string, got "${base}"`);
    b = BigInt(base);
  } else {
    b = base;
  }
  if (b < 0n) throw new RangeError("base units must not be negative");
  if (b % BASE_UNITS_PER_CENT !== 0n) throw new RangeError(`${b} base units is not a whole number of cents`);
  const cents = b / BASE_UNITS_PER_CENT;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cents exceeds the safe integer range");
  return Number(cents);
}
