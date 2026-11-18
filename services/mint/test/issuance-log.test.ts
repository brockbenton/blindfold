import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base58 } from "../src/chain/settleSender.js";
import { isUnsupported, syncIssuanceLog } from "../src/jobs/issuanceLog.js";
import { addProvider, issue, newQuote, redeem, setupMint, sign, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => { h = await setupMint(); });
afterEach(async () => { await h.cleanup(); });

const logIssuance = () => h.req("/v1/blindfold/admin/log-issuance", { method: "POST", auth: true });
const result = async () => (await logIssuance()).json.result as string;
const cents = (base: bigint | undefined) => Number((base ?? 0n) / 10_000n);
const settle = () => h.req("/v1/blindfold/admin/settle", { method: "POST", auth: true });
const state = async () => (await h.db.query("select * from issuance_log_state")).rows[0];

describe("onchain issuance log", () => {
  it("creates the log with this mint's totals, then adds new issuance", async () => {
    const A = await addProvider(h);
    await issue(h, [A.pubkey], [32, 8]);
    expect(await result()).toBe("initialized");
    expect(h.vault.issuanceLog).toMatchObject({ seq: 0n });
    expect(cents(h.vault.issuanceLog?.issued)).toBe(40);
    expect(cents(h.vault.issuanceLog?.settled)).toBe(0);

    expect(await result()).toBe("unchanged");
    await issue(h, [A.pubkey], [16]);
    expect(await result()).toBe("logged");
    expect(cents(h.vault.issuanceLog?.issued)).toBe(56);
    expect(h.vault.issuanceLog?.seq).toBe(1n);
    expect(h.sender.logWrites).toBe(2);
    expect(await state()).toMatchObject({ logged_cents: 56, pending_sig: null });
  });

  it("settlement advances the log's settled total, and reserves stay consistent with it", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [32, 8]);
    await logIssuance();
    expect((await redeem(h, sign(proofs.filter((p) => p.amount.toNumber() === 8), A.sk))).status).toBe(200);
    expect((await settle()).status).toBe(200);
    expect(cents(h.vault.issuanceLog?.settled)).toBe(8);
    const reserves = (await h.req("/v1/blindfold/reserves")).json;
    expect(cents(h.vault.issuanceLog!.issued - h.vault.issuanceLog!.settled)).toBe(reserves.outstanding);
  });

  it("uses confirmed settlements as the baseline when the log is created later", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [32, 8]);
    await redeem(h, sign(proofs.filter((p) => p.amount.toNumber() === 8), A.sk));
    await settle();
    expect(await result()).toBe("initialized");
    expect(cents(h.vault.issuanceLog?.issued)).toBe(40);
    expect(cents(h.vault.issuanceLog?.settled)).toBe(8);
  });

  it("defers creating or joining the log while a batch is in flight", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [8]);
    await redeem(h, sign(proofs, A.sk));
    h.sender.neverLand();
    await settle();
    expect(await result()).toBe("deferred");
    expect(h.vault.issuanceLog).toBeNull();
    h.vault.issuanceLog = { issued: 0n, settled: 0n, seq: 0n, updatedSlot: 1n, updatedAt: 1n, bump: 255 };
    expect(await result()).toBe("deferred");
    expect(await state()).toBeUndefined();
  });

  it("keeps settlement out until an outstanding log initialization is resolved", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [8]);
    await redeem(h, sign(proofs, A.sk));
    h.sender.dropNextLog = true;
    expect(await result()).toBe("pending");
    expect((await settle()).status).toBe(409);
    expect(h.sender.sends).toBe(0);
    h.sender.advance(101);
    expect(await result()).toBe("initialized");
    expect((await settle()).status).toBe(200);
    expect(cents(h.vault.issuanceLog?.settled)).toBe(8);
  });

  it("joins a log another mint created, adding only its net issuance", async () => {
    // This mint issued 40 and settled 8 before the log existed; another mint then created it.
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [32, 8]);
    await redeem(h, sign(proofs.filter((p) => p.amount.toNumber() === 8), A.sk));
    await settle();
    h.vault.issuanceLog = { issued: 500n * 10_000n, settled: 200n * 10_000n, seq: 4n, updatedSlot: 1n, updatedAt: 1n, bump: 255 };
    expect(await result()).toBe("logged");
    // +32: its 32 cents still outstanding. Its earlier 8-cent batch is in neither total.
    expect(cents(h.vault.issuanceLog?.issued)).toBe(532);
    expect(cents(h.vault.issuanceLog?.settled)).toBe(200);
  });

  it("does not subtract payouts already counted by the chain when joining", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [32, 8]);
    h.vault.issuanceLog = { issued: 100n * 10_000n, settled: 0n, seq: 0n, updatedSlot: 1n, updatedAt: 1n, bump: 255 };
    await redeem(h, sign(proofs.filter((p) => p.amount.toNumber() === 8), A.sk));
    expect((await settle()).status).toBe(200);
    expect(await result()).toBe("logged");
    expect(cents(h.vault.issuanceLog!.issued - h.vault.issuanceLog!.settled)).toBe(132);
  });

  it("serializes independent sync callers and excludes settlement while a log baseline is pending", async () => {
    const A = await addProvider(h);
    const proofs = await issue(h, [A.pubkey], [8]);
    await redeem(h, sign(proofs, A.sk));
    const d = { db: h.db, vault: h.vault, writer: h.sender };
    const prepare = h.sender.prepareInitIssuanceLog.bind(h.sender);
    let resume!: () => void;
    let notifyEntered!: () => void;
    const waiting = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    h.sender.prepareInitIssuanceLog = async (...args) => {
      notifyEntered();
      await waiting;
      return prepare(...args);
    };
    const first = syncIssuanceLog(d);
    await entered;
    try {
      expect(await syncIssuanceLog(d)).toBe("deferred");
      expect((await settle()).status).toBe(409);
    } finally {
      resume();
      await first;
    }
    expect(h.sender.logWrites).toBe(1);
  });

  it("adds are atomic: another mint's adds in between are kept", async () => {
    const A = await addProvider(h);
    await issue(h, [A.pubkey], [8]);
    await logIssuance();
    h.vault.issuanceLog!.issued += 300n * 10_000n; // another mint logs 300 cents
    await issue(h, [A.pubkey], [16]);
    expect(await result()).toBe("logged");
    expect(cents(h.vault.issuanceLog?.issued)).toBe(8 + 300 + 16);
  });

  it("a lost response is resolved from the chain, never added twice", async () => {
    const A = await addProvider(h);
    await issue(h, [A.pubkey], [8]);
    await logIssuance();
    await issue(h, [A.pubkey], [16]);
    h.sender.loseNextLogResponse = true;
    expect(await result()).toBe("logged");
    expect(await result()).toBe("unchanged");
    expect(cents(h.vault.issuanceLog?.issued)).toBe(24);
  });

  it("a transaction that never lands stays pending until it expires, then is sent again once", async () => {
    const A = await addProvider(h);
    await issue(h, [A.pubkey], [8]);
    await logIssuance();
    await issue(h, [A.pubkey], [16]);
    h.sender.dropNextLog = true;
    expect(await result()).toBe("pending");
    expect(await state()).toMatchObject({ pending_kind: "add", pending_cents: 16 });
    expect(await result()).toBe("pending"); // not expired: nothing new is sent
    expect(cents(h.vault.issuanceLog?.issued)).toBe(8);
    h.sender.advance(101);
    expect(await result()).toBe("logged");
    expect(cents(h.vault.issuanceLog?.issued)).toBe(24);
    expect(await state()).toMatchObject({ logged_cents: 24, pending_sig: null });
  });

  it("reports an old program without the instructions as unsupported, and clears the attempt", async () => {
    h.sender.issuanceUnsupported = true;
    expect(await result()).toBe("unsupported");
    expect(await state()).toBeUndefined();
    expect(isUnsupported({ logs: ["Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101."] })).toBe(true);
    expect(isUnsupported(new Error("Transaction simulation failed: custom program error: 0x65"))).toBe(true);
    expect(isUnsupported(new Error("custom program error: 0x1770"))).toBe(false);
  });

  it("requires the admin token", async () => {
    expect((await h.req("/v1/blindfold/admin/log-issuance", { method: "POST" })).status).toBe(401);
  });

  it("encodes signatures in base58", () => {
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe("112");
    expect(base58(Buffer.from("hello world"))).toBe("StV1DL6CwTryKyV");
  });
});

describe("poll-deposits hint", () => {
  it("credits a new deposit immediately, only from the vault's DepositRecord", async () => {
    const q = await newQuote(h, 25);
    h.vault.addDeposit({ amountBase: 25n * 10_000n, depositRef: q.request });
    expect((await h.req("/v1/blindfold/admin/poll-deposits", { method: "POST", auth: true })).json).toEqual({ processed: 1 });
    expect((await h.req(`/v1/mint/quote/solana-usdc/${q.quote}`)).json.amount_paid).toBe(25);
    // A hint with nothing new onchain credits nothing.
    expect((await h.req("/v1/blindfold/admin/poll-deposits", { method: "POST", auth: true })).json).toEqual({ processed: 0 });
  });

  it("coalesces concurrent hints into one poll", async () => {
    const q = await newQuote(h, 10);
    h.vault.addDeposit({ amountBase: 10n * 10_000n, depositRef: q.request });
    const results = await Promise.all([h.ctx.pollDeposits(), h.ctx.pollDeposits(), h.ctx.pollDeposits()]);
    expect(results).toEqual([1, 1, 1]);
    expect((await h.db.query("select count(*)::int as n from deposits")).rows[0].n).toBe(1);
  });

  it("requires the admin token", async () => {
    expect((await h.req("/v1/blindfold/admin/poll-deposits", { method: "POST" })).status).toBe(401);
  });
});
