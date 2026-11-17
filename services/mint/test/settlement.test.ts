import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSettlement } from "../src/jobs/settlement.js";
import { addProvider, balances, issue, redeem, setupMint, sign, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => { h = await setupMint(); });
afterEach(async () => { await h.cleanup(); });

const settle = () => h.req("/v1/blindfold/admin/settle", { method: "POST", auth: true });
const rows = async () => (await h.db.query("select * from settlements order by id")).rows;
const reserves = async () => (await h.req("/v1/blindfold/reserves")).json;
const reconcile = async () => (await h.req("/v1/blindfold/admin/reconcile", { auth: true })).json;

/** Mint `amounts` locked to `ps`, then have ps[i] redeem amounts[i]. */
async function earn(ps: { sk: string; pubkey: string; id: number }[], amounts: number[]) {
  const proofs = await issue(h, ps.map((p) => p.pubkey), amounts);
  for (let i = 0; i < ps.length; i++) {
    const own = proofs.filter((p) => p.amount.toNumber() === amounts[i]);
    const r = await redeem(h, sign(own.slice(0, 1), ps[i].sk));
    expect(r.status).toBe(200);
  }
}

describe("admin auth and reads", () => {
  it("401 without or with a wrong token", async () => {
    for (const [m, p] of [["GET", "/v1/blindfold/admin/balances"], ["POST", "/v1/blindfold/admin/settle"], ["GET", "/v1/blindfold/admin/reconcile"]] as const) {
      expect((await h.req(p, { method: m })).status).toBe(401);
      expect((await h.req(p, { method: m, auth: "wrong" })).status).toBe(401);
    }
    expect((await h.req("/v1/blindfold/reserves")).status).toBe(200);
  });
});

describe("settlement", () => {
  it("empty returns batch_id null", async () => {
    expect((await settle()).json).toEqual({ batch_id: null });
  });

  it("pays base units = cents * 10000, confirms, zeroes balances, reconcile holds", async () => {
    const A = await addProvider(h), B = await addProvider(h);
    await earn([A, B], [16, 4]);
    expect(await balances(h)).toEqual({ [A.id]: 16, [B.id]: 4 });
    const r = await settle();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ batch_id: 1, payouts: [{ provider_id: A.id, amount: 16 }, { provider_id: B.id, amount: 4 }] });
    expect(r.json.tx).toMatch(/^fake-tx/);
    expect(h.vault.paid.get(A.id)).toBe(160_000n);
    expect(h.vault.paid.get(B.id)).toBe(40_000n);
    expect(await balances(h)).toEqual({});
    expect((await rows())[0]).toMatchObject({ status: "confirmed", batch_id: 1 });
    expect((await rows())[0].payouts[0]).toMatchObject({ amount_cents: 16, amount_base: "160000" });
    expect(await reconcile()).toEqual({ vault_balance: 0, deposited: 20, issued: 20, redeemed: 20, settled: 20 });
    expect((await settle()).json).toEqual({ batch_id: null });
  });

  it("debits at pending so a redeem during submitted is not lost; resend after expiry", async () => {
    const A = await addProvider(h);
    await earn([A], [8]);
    h.sender.neverLand();
    const first = await settle();
    expect(first.status).toBe(409);
    expect((await rows())[0]).toMatchObject({ status: "submitted", batch_id: 1 });
    expect(await balances(h)).toEqual({});
    await earn([A], [2]); // redeem while submitted
    expect(await balances(h)).toEqual({ [A.id]: 2 });
    // still in flight: waits
    expect((await settle()).status).toBe(409);
    expect(h.sender.sends).toBe(1);
    h.sender.advance(1000); // blockhash expired, never landed
    const r = await settle();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ batch_id: 1, payouts: [{ provider_id: A.id, amount: 8 }] });
    expect(await balances(h)).toEqual({ [A.id]: 2 });
    expect(h.vault.paid.get(A.id)).toBe(80_000n);
  });

  it("crash after the batch landed ends confirmed with no second send", async () => {
    const A = await addProvider(h);
    await earn([A], [4]);
    h.sender.failNext("afterLand");
    expect((await settle()).status).toBe(500);
    expect((await rows())[0].status).toBe("pending");
    const r = await settle();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ batch_id: 1 });
    expect(h.sender.sends).toBe(1);
    expect((await rows()).map((x) => x.status)).toEqual(["confirmed"]);
    expect(h.vault.paid.get(A.id)).toBe(40_000n);
  });

  it("transient send failure keeps the batch pending and the next run sends it once", async () => {
    const A = await addProvider(h);
    await earn([A], [4]);
    h.sender.failNext("send");
    expect((await settle()).status).toBe(500);
    expect(await balances(h)).toEqual({});
    expect((await settle()).status).toBe(200);
    expect(h.sender.sends).toBe(1);
  });

  it("BadBatchId re-reads the chain: batch landed elsewhere means confirmed", async () => {
    const A = await addProvider(h);
    await earn([A], [4]);
    h.sender.raceNext();
    const r = await settle();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ batch_id: 1 });
    expect((await rows()).map((x) => x.status)).toEqual(["confirmed"]);
    expect(h.sender.sends).toBe(0);
  });

  it("deterministic failure restores balances and the next batch reuses the batch_id", async () => {
    const A = await addProvider(h), B = await addProvider(h);
    await earn([A, B], [8, 2]);
    h.sender.failNextProgram("PayoutAccountMismatch");
    const bad = await settle();
    expect(bad.status).toBe(502);
    expect(bad.json.code).toBe(70012);
    expect(await balances(h)).toEqual({ [A.id]: 8, [B.id]: 2 });
    expect((await rows())[0]).toMatchObject({ status: "failed", batch_id: 1 });
    expect((await rows())[0].error).toContain("PayoutAccountMismatch");
    const ok = await settle();
    expect(ok.status).toBe(200);
    expect(ok.json.batch_id).toBe(1);
    expect((await rows()).map((x) => [x.batch_id, x.status])).toEqual([[1, "failed"], [1, "confirmed"]]);
  });

  it("two concurrent runs: one settles, the other is refused or finds nothing", async () => {
    const A = await addProvider(h);
    await earn([A], [4]);
    const rs = await Promise.all([settle(), settle()]);
    expect(rs.filter((r) => r.status === 200 && r.json.batch_id === 1)).toHaveLength(1);
    expect(h.sender.sends).toBe(1);
    expect((await rows())).toHaveLength(1);
  });

  it("more than 8 providers: first call pays the 8 largest, second the rest", async () => {
    const ps = [];
    for (let i = 0; i < 10; i++) ps.push(await addProvider(h));
    const amounts = Array.from({ length: 10 }, (_, i) => 2 ** i); // provider i earns 2^i
    const proofs = await issue(h, ps.map((p) => p.pubkey), amounts);
    for (let i = 0; i < 10; i++) {
      const p = proofs.find((x) => x.amount.toNumber() === amounts[i])!;
      expect((await redeem(h, sign([p], ps[i].sk))).status).toBe(200);
    }
    const first = (await settle()).json;
    expect(first.batch_id).toBe(1);
    expect(first.payouts.map((p: any) => p.provider_id)).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(await balances(h)).toEqual({ [ps[0].id]: 1, [ps[1].id]: 2 });
    const second = (await settle()).json;
    expect(second.batch_id).toBe(2);
    expect(second.payouts.map((p: any) => p.provider_id)).toEqual([1, 0]);
  });
});

describe("deactivated provider", () => {
  it("is listed inactive, skipped by settlement, balance stays visible; topics default to []", async () => {
    const A = await addProvider(h), B = await addProvider(h);
    await earn([A, B], [4, 2]);
    h.vault.setActive(B.id, false);
    await h.ctx.tick();
    const list = (await h.req("/v1/blindfold/providers")).json;
    expect(list).toEqual([
      { provider_id: 0, pubkey: A.pubkey, name: "mock-api", url: "http://localhost:4000", price_cents: 5, topics: ["sol", "btc"], active: true },
      { provider_id: 1, pubkey: B.pubkey, name: null, url: null, price_cents: null, topics: [], active: false },
    ]);
    const r = await settle();
    expect(r.json.payouts).toEqual([{ provider_id: A.id, amount: 4 }]);
    expect(await balances(h)).toEqual({ [B.id]: 2 });
    expect((await settle()).json).toEqual({ batch_id: null });
    expect(await balances(h)).toEqual({ [B.id]: 2 });
  });

  it("a providers.json entry without topics serves []", async () => {
    await h.cleanup();
    h = await setupMint({ providersFile: [{ provider_id: 0, name: "x", url: null, price_cents: null, topics: [] }] });
    await addProvider(h);
    expect((await h.req("/v1/blindfold/providers")).json[0]).toMatchObject({ name: "x", topics: [] });
  });
});

describe("reserves", () => {
  it("mint 100, redeem 40, settled in full: issued 100, settled 40, outstanding 60; pending and failed are not settled", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [32, 8, 32, 16, 8, 4]);
    const r0 = await reserves();
    expect(r0).toMatchObject({ issued: 100, settled: 0, outstanding: 100 });
    expect(r0.keyset_id).toBe(h.ctx.keysets.activeId);
    expect(typeof r0.updated_at).toBe("number");
    // redeem 32 + 8
    await redeem(h, sign([proofs[0], proofs[1]], A.sk));
    h.sender.neverLand();
    expect((await settle()).status).toBe(409); // submitted
    expect((await reserves()).settled).toBe(0);
    h.sender.advance(1000);
    h.sender.failNextProgram("ProviderInactive");
    expect((await settle()).status).toBe(502); // failed
    expect((await reserves()).settled).toBe(0);
    expect((await settle()).status).toBe(200); // confirmed
    expect(await reserves()).toMatchObject({ issued: 100, settled: 40, outstanding: 60 });
    expect(await reconcile()).toMatchObject({ vault_balance: 60, deposited: 100, settled: 40, issued: 100, redeemed: 40 });
  });
});

describe("job wiring", () => {
  it("runSettlement without a sync dependency works", async () => {
    expect(await runSettlement({ db: h.db, vault: h.vault, sender: h.sender })).toEqual({ batch_id: null });
  });
});

describe("settlement privacy policy", () => {
  // Fresh harness per test, with a policy. The outer beforeEach harness is cleaned up by the outer afterEach.
  let p: Harness;
  afterEach(async () => { await p?.cleanup(); });
  const pSettle = () => p.req("/v1/blindfold/admin/settle", { method: "POST", auth: true });
  const age = (s: number) => p.db.query(`update redemptions set created_at = now() - make_interval(secs => ${s})`);
  async function pEarn(prov: { sk: string; pubkey: string }, amount: number) {
    const proofs = await issue(p, [prov.pubkey], [amount]);
    expect((await redeem(p, sign(proofs.filter((x) => x.amount.toNumber() === amount).slice(0, 1), prov.sk))).status).toBe(200);
  }

  it("hold: cents redeemed inside the window wait for a later run", async () => {
    p = await setupMint({ cfg: { settleHoldS: 600, settleUnitCents: 1 } });
    const A = await addProvider(p);
    await pEarn(A, 8);
    expect((await pSettle()).json).toEqual({ batch_id: null });
    expect(await balances(p)).toEqual({ [A.id]: 8 });
    await age(601);
    await pEarn(A, 4); // fresh: held back while the aged 8 is paid
    const r = await pSettle();
    expect(r.json).toMatchObject({ batch_id: 1, payouts: [{ provider_id: A.id, amount: 8 }] });
    expect(await balances(p)).toEqual({ [A.id]: 4 });
    expect(p.vault.paid.get(A.id)).toBe(80_000n);
  });

  it("unit: payouts round down and the remainder carries over", async () => {
    p = await setupMint({ cfg: { settleHoldS: 0, settleUnitCents: 10 } });
    const A = await addProvider(p), B = await addProvider(p);
    await pEarn(A, 16);
    await pEarn(B, 4);
    const r = await pSettle();
    expect(r.json).toMatchObject({ batch_id: 1, payouts: [{ provider_id: A.id, amount: 10 }] });
    expect(await balances(p)).toEqual({ [A.id]: 6, [B.id]: 4 });
    await pEarn(B, 8);
    expect((await pSettle()).json).toMatchObject({ batch_id: 2, payouts: [{ provider_id: B.id, amount: 10 }] });
    expect(await balances(p)).toEqual({ [A.id]: 6, [B.id]: 2 });
    const rec = (await p.req("/v1/blindfold/admin/reconcile", { auth: true })).json;
    expect(rec.vault_balance).toBe(rec.deposited - rec.settled);
    expect((await p.req("/v1/blindfold/reserves")).json).toMatchObject({ settled: 20, outstanding: rec.issued - 20 });
  });

  it("a failed batch restores only what it debited", async () => {
    p = await setupMint({ cfg: { settleHoldS: 0, settleUnitCents: 10 } });
    const A = await addProvider(p);
    await pEarn(A, 16);
    p.sender.failNextProgram("PayoutAccountMismatch");
    expect((await pSettle()).status).toBe(502);
    expect(await balances(p)).toEqual({ [A.id]: 16 });
  });
});
