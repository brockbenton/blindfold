import { describe, expect, it } from "vitest";
import { makeProviderKey } from "@blindfold/testkit";
import { planDenominations } from "../src/denominations.js";
import { selectExact } from "../src/select.js";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const isPow2 = (n: number) => n >= 1 && n <= 4096 && (n & (n - 1)) === 0;

describe("planDenominations", () => {
  it("100 cents at price 5: sums, powers of two, 16 bundles of 4+1", () => {
    const plan = planDenominations(100, [5]);
    expect(sum(plan)).toBe(100);
    expect(plan.every(isPow2)).toBe(true);
    expect(plan.slice(0, 32)).toEqual(Array.from({ length: 16 }, () => [4, 1]).flat());
    expect(plan.length).toBe(40);
  });
  it("handles multiple prices and tiny amounts", () => {
    for (const [c, p] of [[100, [5, 3]], [1, [5]], [3, [5]], [5000, [5]], [37, [3, 7, 10]]] as [number, number[]][]) {
      const plan = planDenominations(c, p);
      expect(sum(plan)).toBe(c);
      expect(plan.every(isPow2)).toBe(true);
    }
  });
  it("selectExact pays the first n calls in a row for any price 1..10", () => {
    const pk = makeProviderKey();
    for (let price = 1; price <= 10; price++) {
      const plan = planDenominations(100, [price]);
      // selection only reads amount and secret, so skip the slow blind issuance
      let proofs = plan.map((amount, i) => ({
        amount, id: "00", C: "02" + "11".repeat(32),
        secret: JSON.stringify(["P2PK", { nonce: String(i).padStart(8, "0"), data: pk.pubkey, tags: [] }]),
      }));
      const n = Math.floor(80 / price);
      for (let i = 0; i < n; i++) {
        const r = selectExact(proofs, price, pk.pubkey);
        expect("chosen" in r, `price ${price} call ${i}`).toBe(true);
        const used = new Set((r as { chosen: { secret: string }[] }).chosen.map((p) => p.secret));
        proofs = proofs.filter((p) => !used.has(p.secret));
      }
    }
  });
});
