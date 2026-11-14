import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pollDeposits } from "../src/jobs/depositPoller.js";
import { fund, newQuote, setupMint, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => { h = await setupMint(); });
afterAll(async () => { await h.cleanup(); });

const quote = async (id: string) => (await h.req(`/v1/mint/quote/solana-usdc/${id}`)).json;

describe("deposit poller", () => {
  it("credits the right quotes, sums two deposits to one ref, stores unmatched", async () => {
    const [a, b, c] = [await newQuote(h, 100), await newQuote(h, 200), await newQuote(h, 300)];
    h.vault.addDeposit({ amountBase: 1_000_000n, depositRef: a.request });
    h.vault.addDeposit({ amountBase: 1_500_000n, depositRef: b.request });
    h.vault.addDeposit({ amountBase: 500_000n, depositRef: b.request });
    h.vault.addDeposit({ amountBase: 20_000n, depositRef: "ab".repeat(32) }); // no quote
    expect(await pollDeposits(h.db, h.vault)).toBe(4);
    expect((await quote(a.quote)).amount_paid).toBe(100);
    expect((await quote(b.quote)).amount_paid).toBe(200); // 150 + 50, even if different from `amount`
    expect((await quote(c.quote)).amount_paid).toBe(0);
    const unmatched = await h.db.query("select * from deposits where quote_id is null");
    expect(unmatched.rows).toHaveLength(1);
    expect(unmatched.rows[0]).toMatchObject({ index: 3, amount_cents: 2 });
    expect(await pollDeposits(h.db, h.vault)).toBe(0);
  });

  it("does not double credit after a restart that lost the cursor", async () => {
    const q = await newQuote(h, 100);
    await fund(h, q, 100);
    expect((await quote(q.quote)).amount_paid).toBe(100);
    await h.db.query("update deposit_cursor set next_index = 0");
    await pollDeposits(h.db, h.vault);
    expect((await quote(q.quote)).amount_paid).toBe(100);
    expect((await h.db.query("select next_index from deposit_cursor")).rows[0].next_index).toBe(h.vault.deposits.length);
  });

  it("stops and retries when a record is not visible yet, and surfaces wrong-owner errors", async () => {
    const q = await newQuote(h, 100);
    const real = h.vault.getDeposits.bind(h.vault);
    h.vault.getDeposits = async (idx) => (await real(idx)).map(() => null);
    h.vault.addDeposit({ amountBase: 1_000_000n, depositRef: q.request });
    expect(await pollDeposits(h.db, h.vault)).toBe(0);
    h.vault.getDeposits = real;
    h.vault.failReads = true;
    await expect(pollDeposits(h.db, h.vault)).rejects.toThrow(/not owned/);
    h.vault.failReads = false;
    expect(await pollDeposits(h.db, h.vault)).toBe(1);
    expect((await quote(q.quote)).amount_paid).toBe(100);
  });

  it("catches up past one chunk", async () => {
    const q = await newQuote(h, 100);
    for (let i = 0; i < 120; i++) h.vault.addDeposit({ amountBase: 10_000n, depositRef: i === 119 ? q.request : "cd".repeat(32) });
    expect(await pollDeposits(h.db, h.vault)).toBe(120);
    expect((await quote(q.quote)).amount_paid).toBe(1);
  });
});
