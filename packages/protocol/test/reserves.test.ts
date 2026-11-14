import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { VAULT_IDL, checkReserves, configPda, vaultAta, type ReserveConnection } from "../src/index.js";

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

function conn(o: { owner?: PublicKey; data?: Uint8Array; amount?: string; rpcError?: boolean; missing?: boolean }): ReserveConnection {
  return {
    async getAccountInfo(a) {
      if (o.rpcError) throw new Error("rpc down");
      expect(a.equals(configPda(programId))).toBe(true);
      return o.missing ? null : { owner: o.owner ?? programId, data: o.data! };
    },
    async getTokenAccountBalance(a) {
      if (o.rpcError) throw new Error("rpc down");
      expect(a.equals(vaultAta(usdcMint, programId))).toBe(true);
      return { value: { amount: o.amount ?? "0" } };
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
    expect(await run(conn({ data, amount: "6000000" }), reserves(600))).toEqual({ ok: true, vaultCents: 600, outstandingCents: 600 });
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
  it("fails when the vault balance is not whole cents", async () => {
    expect((await run(conn({ data: await configData(), amount: "10001" }), reserves(0))).ok).toBe(false);
  });
});
