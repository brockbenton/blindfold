import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { VAULT_IDL, checkReserves, configPda, issuancePda, vaultAta, type ReserveConnection } from "../src/index.js";

const programId = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const coder = new BorshAccountsCoder(VAULT_IDL);

async function configData(over: { usdcMint?: PublicKey; vaultToken?: PublicKey } = {}) {
  const k = () => Keypair.generate().publicKey;
  return coder.encode("Config", {
    admin: k(), mint_authority: k(), usdc_mint: over.usdcMint ?? usdcMint,
    vault_token: over.vaultToken ?? vaultAta(usdcMint, programId),
    max_deposit: new BN(1), deposit_count: new BN(0), provider_count: 0, last_batch_id: new BN(0), bump: 1,
  });
}

function logData(issuedCents: number, settledCents: number) {
  return coder.encode("IssuanceLog", {
    issued: new BN(issuedCents * 10_000), settled: new BN(settledCents * 10_000), seq: new BN(3), updated_slot: new BN(9), updated_at: new BN(1), bump: 254,
  });
}

function conn(o: {
  owner?: PublicKey; data?: Uint8Array; amount?: string; rpcError?: boolean; missing?: boolean;
  log?: Uint8Array; logOwner?: PublicKey;
}): ReserveConnection {
  return {
    async getMultipleAccountsInfo(accounts) {
      if (o.rpcError) throw new Error("rpc down");
      expect(accounts).toEqual([configPda(programId), vaultAta(usdcMint, programId), issuancePda(programId)]);
      const data = Buffer.alloc(165);
      usdcMint.toBuffer().copy(data, 0);
      configPda(programId).toBuffer().copy(data, 32);
      data.writeBigUInt64LE(BigInt(o.amount ?? "0"), 64);
      data[108] = 1; // initialized
      return [
        o.missing ? null : { owner: o.owner ?? programId, data: o.data! },
        { owner: TOKEN_PROGRAM_ID, data },
        o.log ? { owner: o.logOwner ?? programId, data: o.log } : null,
      ];
    },
  };
}
const reserves = (outstanding: unknown, status = 200): typeof fetch => async (url) => {
  expect(String(url)).toBe("http://mint.test/v1/blindfold/reserves");
  return new Response(JSON.stringify({ issued: 0, settled: 0, outstanding, keyset_id: "x", updated_at: 1 }), { status });
};
const run = (connection: ReserveConnection, f: typeof fetch) =>
  checkReserves({ connection, programId, usdcMint, mintUrl: "http://mint.test/", fetch: f });

describe("checkReserves", () => {
  it("passes when vault covers outstanding (equal and above)", async () => {
    const data = await configData();
    expect(await run(conn({ data, amount: "6000000" }), reserves(600))).toEqual({
      ok: true, vaultCents: 600, outstandingCents: 600, verified: false, mintOutstandingCents: 600,
      note: "unverified: no onchain issuance log, liabilities are mint-reported",
    });
    expect((await run(conn({ data, amount: "7000000" }), reserves(600))).ok).toBe(true);
  });
  it("fails when underfunded", async () => {
    const r = await run(conn({ data: await configData(), amount: "5990000" }), reserves(600));
    expect(r).toMatchObject({ ok: false, vaultCents: 599, outstandingCents: 600 });
    expect(r.reason).toMatch(/outstanding/);
  });
  it("fails on wrong owner", async () => {
    const r = await run(conn({ data: await configData(), owner: Keypair.generate().publicKey, amount: "9" }), reserves(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/owned/);
  });
  it("fails on wrong mint and wrong vault token", async () => {
    const bad = await configData({ usdcMint: Keypair.generate().publicKey });
    expect((await run(conn({ data: bad }), reserves(0))).reason).toMatch(/usdc_mint/);
    const bad2 = await configData({ vaultToken: Keypair.generate().publicKey });
    expect((await run(conn({ data: bad2 }), reserves(0))).reason).toMatch(/vault_token/);
  });
  it("fails closed on missing config, RPC error and garbage data", async () => {
    expect((await run(conn({ missing: true }), reserves(0))).ok).toBe(false);
    const r = await run(conn({ rpcError: true }), reserves(0));
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toMatch(/rpc down/);
    expect((await run(conn({ data: new Uint8Array(10) }), reserves(0))).ok).toBe(false);
  });
  it("fails closed on mint errors", async () => {
    const data = await configData();
    expect((await run(conn({ data, amount: "9000000" }), reserves(0, 500))).reason).toMatch(/HTTP 500/);
    const throwing: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    expect((await run(conn({ data, amount: "9000000" }), throwing)).reason).toMatch(/ECONNREFUSED/);
    expect((await run(conn({ data, amount: "9000000" }), reserves("lots"))).ok).toBe(false);
    expect((await run(conn({ data, amount: "9000000" }), reserves(-1))).ok).toBe(false);
  });
  it.each([
    ["10001", 1, 1, true],
    ["9999", 0, 0, true],
    ["9999", 1, 0, false],
    ["5999999", 600, 599, false],
    ["6000001", 600, 600, true],
  ])("counts only whole cents in vault balance %s", async (amount, outstanding, vaultCents, ok) => {
    expect(await run(conn({ data: await configData(), amount }), reserves(outstanding)))
      .toMatchObject({ ok, vaultCents, outstandingCents: outstanding });
  });
  it("fails closed on invalid vault balances", async () => {
    const data = await configData();
    for (const amount of ["-1", "invalid", (BigInt(Number.MAX_SAFE_INTEGER) * 10_000n + 10_000n).toString()]) {
      expect((await run(conn({ data, amount }), reserves(0))).ok).toBe(false);
    }
  });
});

describe("checkReserves with the onchain issuance log", () => {
  it("verifies liabilities from the log", async () => {
    const r = await run(conn({ data: await configData(), amount: "6000000", log: await logData(1000, 400) }), reserves(600));
    expect(r).toMatchObject({ ok: true, verified: true, onchainOutstandingCents: 600, mintOutstandingCents: 600, outstandingCents: 600 });
    expect(r.note).toBeUndefined();
  });
  it("catches a mint that under-reports: the log wins", async () => {
    const r = await run(conn({ data: await configData(), amount: "5000000", log: await logData(1000, 400) }), reserves(100));
    expect(r).toMatchObject({ ok: false, verified: true, outstandingCents: 600, vaultCents: 500 });
    expect(r.reason).toMatch(/600 cents are outstanding/);
  });
  it("uses the mint's report when it is higher (issuance not yet logged)", async () => {
    const r = await run(conn({ data: await configData(), amount: "7000000", log: await logData(1000, 400) }), reserves(650));
    expect(r).toMatchObject({ ok: true, verified: false, outstandingCents: 650 });
    expect(r.note).toMatch(/50 cents not yet logged/);
    expect((await run(conn({ data: await configData(), amount: "6400000", log: await logData(1000, 400) }), reserves(650))).ok).toBe(false);
  });
  it("fails closed when the log could omit recent issuance and the mint is down", async () => {
    const down: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    const r = await run(conn({ data: await configData(), amount: "6000000", log: await logData(1000, 400) }), down);
    expect(r).toMatchObject({ ok: false, verified: false, onchainOutstandingCents: 600 });
    expect(r.reason).toMatch(/ECONNREFUSED/);
  });
  it("fails closed on a foreign, inconsistent or garbage log", async () => {
    const data = await configData();
    const foreign = await run(conn({ data, amount: "9000000", log: await logData(10, 0), logOwner: Keypair.generate().publicKey }), reserves(0));
    expect(foreign).toMatchObject({ ok: false });
    expect(foreign.reason).toMatch(/issuance log is not owned/);
    expect((await run(conn({ data, amount: "9000000", log: await logData(10, 20) }), reserves(0))).reason).toMatch(/settled exceeds issued/);
    expect((await run(conn({ data, amount: "9000000", log: new Uint8Array(12) }), reserves(0))).ok).toBe(false);
  });
});
