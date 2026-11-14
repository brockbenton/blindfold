import { createHash } from "node:crypto";
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  BASE_UNITS_PER_CENT, DEFAULT_VAULT_PROGRAM_ID, MAX_PAYOUTS_PER_BATCH, VAULT_IDL, buildDeactivateProviderIx,
  buildDepositIx, buildInitializeIx, buildRegisterProviderIx, buildSettleBatchIx, configPda, decodeConfig,
  decodeDepositRecord, decodeInstruction, decodeProviderRecord, depositPda, providerPda, vaultAta,
} from "../src/index.js";

const disc = (s: string) => [...createHash("sha256").update(s).digest().subarray(0, 8)];
const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const k = () => Keypair.generate().publicKey;

describe("IDL self-consistency", () => {
  it("discriminators match sha256", () => {
    for (const i of VAULT_IDL.instructions) expect(i.discriminator).toEqual(disc(`global:${i.name}`));
    for (const a of VAULT_IDL.accounts!) expect(a.discriminator).toEqual(disc(`account:${a.name}`));
    for (const e of VAULT_IDL.events!) expect(e.discriminator).toEqual(disc(`event:${e.name}`));
  });
  it("has the five instructions and ordered errors", () => {
    // The generated IDL lists instructions alphabetically, so compare as a set.
    expect(VAULT_IDL.instructions.map((i) => i.name).sort()).toEqual(
      ["initialize", "deposit", "register_provider", "deactivate_provider", "settle_batch"].sort(),
    );
    expect(VAULT_IDL.errors!.map((e) => e.code)).toEqual(Array.from({ length: 15 }, (_, i) => 6000 + i));
    expect(VAULT_IDL.errors![0].name).toBe("InvalidAmount");
    expect(VAULT_IDL.errors![14].name).toBe("MathOverflow");
    expect(snake("DepositRecord")).toBe("deposit_record");
  });
});

describe("PDAs", () => {
  it("are stable and distinct", () => {
    const pid = DEFAULT_VAULT_PROGRAM_ID;
    expect(configPda(pid).toBase58()).toBe(configPda().toBase58());
    expect(configPda(pid).toBase58()).toBe(
      PublicKey.findProgramAddressSync([Buffer.from("config")], pid)[0].toBase58());
    expect(depositPda(0, pid).equals(depositPda(1, pid))).toBe(false);
    expect(depositPda(3n, pid).toBase58()).toBe(depositPda(3, pid).toBase58());
    expect(depositPda(1, pid).toBase58()).toBe(PublicKey.findProgramAddressSync(
      [Buffer.from("deposit"), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])], pid)[0].toBase58());
    expect(providerPda(2, pid).toBase58()).toBe(PublicKey.findProgramAddressSync(
      [Buffer.from("provider"), Buffer.from([2, 0, 0, 0])], pid)[0].toBase58());
    expect(vaultAta(USDC, pid).equals(vaultAta(USDC, k()))).toBe(false);
  });
});

describe("account decoders", () => {
  const coder = new BorshAccountsCoder(VAULT_IDL);
  it("decodes a hand-encoded Config buffer", () => {
    const admin = k(), ma = k(), vt = k();
    const buf = Buffer.concat([
      Buffer.from(disc("account:Config")), admin.toBuffer(), ma.toBuffer(), USDC.toBuffer(), vt.toBuffer(),
      Buffer.from("40420f0000000000", "hex"), // max_deposit 1_000_000
      Buffer.from("0300000000000000", "hex"), // deposit_count 3
      Buffer.from("02000000", "hex"), // provider_count 2
      Buffer.from("0700000000000000", "hex"), // last_batch_id 7
      Buffer.from([254]),
    ]);
    const c = decodeConfig(buf);
    expect(c.admin.equals(admin) && c.mintAuthority.equals(ma) && c.usdcMint.equals(USDC) && c.vaultToken.equals(vt)).toBe(true);
    expect(c).toMatchObject({ maxDeposit: 1_000_000n, depositCount: 3n, providerCount: 2, lastBatchId: 7n, bump: 254 });
  });
  it("decodes DepositRecord and ProviderRecord via encode round trip", async () => {
    const depositor = k();
    const dep = await coder.encode("DepositRecord", {
      index: new BN(4), depositor, amount: new BN(50_000), deposit_ref: Array(32).fill(9),
      slot: new BN(100), timestamp: new BN(-5), bump: 255,
    });
    const d = decodeDepositRecord(dep);
    expect(d).toMatchObject({ index: 4n, amount: 50_000n, slot: 100n, timestamp: -5n, bump: 255 });
    expect(d.depositor.equals(depositor)).toBe(true);
    expect([...d.depositRef]).toEqual(Array(32).fill(9));

    const payout = k();
    const prov = await coder.encode("ProviderRecord", {
      provider_id: 1, cashu_pubkey: [2, ...Array(32).fill(7)], payout_token: payout, active: true, bump: 250,
    });
    const p = decodeProviderRecord(prov);
    expect(p).toMatchObject({ providerId: 1, active: true, bump: 250 });
    expect(p.cashuPubkey[0]).toBe(2);
    expect(p.payoutToken.equals(payout)).toBe(true);
  });
  it("rejects a wrong discriminator", () => {
    expect(() => decodeConfig(Buffer.alloc(200))).toThrow();
  });
});

describe("instruction builders", () => {
  const pid = DEFAULT_VAULT_PROGRAM_ID;
  const dataDisc = (ixn: { data: Buffer }) => [...ixn.data.subarray(0, 8)];

  it("initialize", () => {
    const admin = k(), ma = k();
    const i = buildInitializeIx({ admin, usdcMint: USDC, mintAuthority: ma, maxDeposit: 50_000_000n });
    expect(dataDisc(i)).toEqual(disc("global:initialize"));
    const dec = decodeInstruction(i.data)!;
    expect(dec.name).toBe("initialize");
    expect((dec.data as any).max_deposit.toString()).toBe("50000000");
    expect(i.keys).toHaveLength(7);
    expect(i.keys[0]).toMatchObject({ isSigner: true, isWritable: true });
    expect(i.keys[1].pubkey.equals(configPda(pid))).toBe(true);
    expect(i.keys[3].pubkey.equals(vaultAta(USDC, pid))).toBe(true);
  });
  it("deposit", () => {
    const depositor = k(), tok = k();
    const ref = Buffer.alloc(32, 5);
    const i = buildDepositIx({ depositor, depositorToken: tok, usdcMint: USDC, amount: 5n * BASE_UNITS_PER_CENT, depositRef: ref.toString("hex"), depositIndex: 9n });
    const dec = decodeInstruction(i.data)!;
    expect(dec.name).toBe("deposit");
    expect((dec.data as any).amount.toString()).toBe("50000");
    expect([...(dec.data as any).deposit_ref]).toEqual([...ref]);
    expect(i.keys.map((x) => x.isWritable)).toEqual([true, true, true, true, true, false, false, false]);
    expect(i.keys[2].pubkey.equals(depositPda(9, pid))).toBe(true);
    expect(() => buildDepositIx({ depositor, depositorToken: tok, usdcMint: USDC, amount: 1n, depositRef: "ab", depositIndex: 0 })).toThrow(/32 bytes/);
  });
  it("register_provider and deactivate_provider", () => {
    const admin = k(), payout = k();
    const pub = new Uint8Array([3, ...Array(32).fill(1)]);
    const r = buildRegisterProviderIx({ admin, providerId: 4, cashuPubkey: pub, payoutToken: payout });
    const dec = decodeInstruction(r.data)!;
    expect(dec.name).toBe("register_provider");
    expect([...(dec.data as any).cashu_pubkey]).toEqual([...pub]);
    expect((dec.data as any).payout_token.equals(payout)).toBe(true);
    expect(r.keys[2].pubkey.equals(providerPda(4, pid))).toBe(true);
    expect(r.keys[3].pubkey.equals(payout)).toBe(true);
    expect(() => buildRegisterProviderIx({ admin, providerId: 0, cashuPubkey: "02ab", payoutToken: payout })).toThrow(/33 bytes/);

    const d = buildDeactivateProviderIx({ admin, providerId: 4 });
    expect((decodeInstruction(d.data)!.data as any).provider_id).toBe(4);
    expect(d.keys).toHaveLength(3);
    expect(d.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
    expect(d.keys[2].isWritable).toBe(true);
  });
  it("settle_batch with remaining accounts", () => {
    const ma = k();
    const payouts = [0, 1].map((id) => ({ providerId: id, amount: BigInt(id + 1) * 50_000n, payoutToken: k() }));
    const i = buildSettleBatchIx({ mintAuthority: ma, usdcMint: USDC, batchId: 1n, payouts });
    const dec = decodeInstruction(i.data)!;
    expect(dec.name).toBe("settle_batch");
    expect((dec.data as any).batch_id.toString()).toBe("1");
    expect((dec.data as any).payouts.map((p: any) => [p.provider_id, p.amount.toString()])).toEqual([[0, "50000"], [1, "100000"]]);
    expect(i.keys).toHaveLength(5 + 4);
    expect(i.keys[5].pubkey.equals(providerPda(0, pid))).toBe(true);
    expect(i.keys[6]).toMatchObject({ isWritable: true });
    expect(i.keys[6].pubkey.equals(payouts[0].payoutToken)).toBe(true);
    expect(() => buildSettleBatchIx({ mintAuthority: ma, usdcMint: USDC, batchId: 1, payouts: [] })).toThrow();
    const many = Array.from({ length: MAX_PAYOUTS_PER_BATCH + 1 }, (_, n) => ({ providerId: n, amount: 10_000n, payoutToken: k() }));
    expect(() => buildSettleBatchIx({ mintAuthority: ma, usdcMint: USDC, batchId: 1, payouts: many })).toThrow();
  });
});
