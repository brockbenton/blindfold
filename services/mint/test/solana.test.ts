// The Solana-backed classes against a fake Connection (no validator).
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { PLACEHOLDER_VAULT_PROGRAM_ID, USDC_DEVNET_MINT, VAULT_IDL, configPda, decodeInstruction, depositPda, issuancePda, providerPda, vaultAta } from "@blindfold/protocol";
import { describe, expect, it } from "vitest";
import { ProgramError, SolanaSettleSender, programErrorFrom } from "../src/chain/settleSender.js";
import { SolanaVaultReader } from "../src/chain/vaultReader.js";

const program = new PublicKey(PLACEHOLDER_VAULT_PROGRAM_ID);
const usdc = new PublicKey(USDC_DEVNET_MINT);
const coder = new BorshAccountsCoder(VAULT_IDL);
const k = () => Keypair.generate().publicKey;
const bn = (n: number) => new BN(n);

describe("SolanaVaultReader", () => {
  it("decodes Config, DepositRecord and ProviderRecord and checks the owner", async () => {
    const dref = Array.from({ length: 32 }, (_, i) => i);
    const accounts = new Map<string, { owner: PublicKey; data: Buffer }>();
    accounts.set(configPda(program).toBase58(), {
      owner: program,
      data: await coder.encode("Config", { admin: k(), mint_authority: k(), usdc_mint: usdc, vault_token: vaultAta(usdc, program), max_deposit: bn(5), deposit_count: bn(2), provider_count: 1, last_batch_id: bn(3), bump: 1 }),
    });
    accounts.set(depositPda(0, program).toBase58(), {
      owner: program,
      data: await coder.encode("DepositRecord", { index: bn(0), depositor: k(), amount: bn(1_000_000), deposit_ref: dref, slot: bn(9), timestamp: bn(10), bump: 1 }),
    });
    accounts.set(depositPda(1, program).toBase58(), {
      owner: k(), // forged owner
      data: await coder.encode("DepositRecord", { index: bn(1), depositor: k(), amount: bn(1), deposit_ref: dref, slot: bn(9), timestamp: bn(10), bump: 1 }),
    });
    accounts.set(providerPda(0, program).toBase58(), {
      owner: program,
      data: await coder.encode("ProviderRecord", { provider_id: 0, cashu_pubkey: Array(33).fill(2), payout_token: k(), active: true, bump: 1 }),
    });
    const conn: any = {
      getAccountInfo: async (pk: PublicKey) => accounts.get(pk.toBase58()) ?? null,
      getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((p) => accounts.get(p.toBase58()) ?? null),
      getTokenAccountBalance: async () => ({ value: { amount: "123456" } }),
    };
    const r = new SolanaVaultReader(conn, program, usdc);
    expect(await r.getConfig()).toEqual({ depositCount: 2n, providerCount: 1, lastBatchId: 3n });
    const [d0] = await r.getDeposits([0n]);
    expect(d0).toMatchObject({ index: 0n, amount: 1_000_000n });
    expect(Buffer.from(d0!.depositRef).toString("hex")).toBe(Buffer.from(dref).toString("hex"));
    await expect(r.getDeposits([1n])).rejects.toThrow(/not owned/);
    expect(await r.getDeposits([5n])).toEqual([null]);
    expect((await r.getProvider(0))?.active).toBe(true);
    expect(await r.getProvider(4)).toBeNull();
    expect(await r.getVaultBalanceBase()).toBe(123456n);
    expect(await r.getIssuanceLog()).toBeNull();
    accounts.set(issuancePda(program).toBase58(), {
      owner: program,
      data: await coder.encode("IssuanceLog", { issued: bn(90_000), settled: bn(10_000), seq: bn(1), updated_slot: bn(5), updated_at: bn(6), bump: 1 }),
    });
    expect(await r.getIssuanceLog()).toMatchObject({ issued: 90_000n, settled: 10_000n, seq: 1n });
    accounts.set(issuancePda(program).toBase58(), { ...accounts.get(issuancePda(program).toBase58())!, owner: k() });
    await expect(r.getIssuanceLog()).rejects.toThrow(/not owned/);
  });

  it.each(["mint", "vault"])("rejects Config with a mismatched %s before using its deposits", async (wrong) => {
    const data = await coder.encode("Config", {
      admin: k(), mint_authority: k(), usdc_mint: wrong === "mint" ? k() : usdc,
      vault_token: wrong === "vault" ? k() : vaultAta(usdc, program),
      max_deposit: bn(5), deposit_count: bn(2), provider_count: 0, last_batch_id: bn(0), bump: 1,
    });
    const conn: any = { getAccountInfo: async () => ({ owner: program, data }) };
    await expect(new SolanaVaultReader(conn, program, usdc).getConfig()).rejects.toThrow(/does not match/);
  });
});

describe("SolanaSettleSender", () => {
  it.each([
    ["processed", { InstructionError: [0, "InvalidArgument"] }, "pending"],
    ["processed", null, "pending"],
    ["confirmed", { InstructionError: [0, "InvalidArgument"] }, "failed"],
    ["finalized", { InstructionError: [0, "InvalidArgument"] }, "failed"],
    ["confirmed", null, "confirmed"],
    ["finalized", null, "confirmed"],
  ])("waits for confirmed commitment before classifying %s (%j)", async (confirmationStatus, err, expected) => {
    const conn: any = { getSignatureStatuses: async () => ({ value: [{ confirmationStatus, err }] }) };
    expect(await new SolanaSettleSender(conn, program, usdc, Keypair.generate()).confirm("sig")).toBe(expected);
  });
  it("builds a signed settle_batch with provider/payout account pairs and maps program errors", async () => {
    const authority = Keypair.generate();
    const payout = k();
    let sent: Buffer | undefined;
    const conn: any = {
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 500 }),
      getAccountInfo: async () => null, // no issuance log yet
      sendRawTransaction: async (raw: Buffer) => { sent = raw; return "sig1"; },
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      getBlockHeight: async () => 501,
    };
    const s = new SolanaSettleSender(conn, program, usdc, authority);
    const payouts = [{ providerId: 2, payoutToken: payout.toBase58(), amountBase: 150_000n }];
    conn.getAccountInfo = async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 123 });
    expect(await new SolanaVaultReader(conn, program, usdc).getIssuanceLog()).toBeNull();
    const prepared = await s.prepareSettlement(4n, payouts);
    expect(prepared).toMatchObject({ validUntil: 500, withIssuanceLog: false });
    expect((await s.prepareSettlement(4n, payouts)).sig).not.toBe(prepared.sig);
    expect((await s.prepareLogIssuance(10_000n)).sig).not.toBe((await s.prepareLogIssuance(10_000n)).sig);
    expect(sent).toBeUndefined();
    await prepared.send();
    const tx = Transaction.from(sent!);
    expect(tx.feePayer?.equals(authority.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    const ix = tx.instructions[0];
    const dec = decodeInstruction(ix.data)!;
    expect(dec.name).toBe("settle_batch");
    expect(ix.keys.slice(5).map((m) => m.pubkey.toBase58())).toEqual([providerPda(2, program).toBase58(), payout.toBase58()]);
    // Once the issuance log exists, the batch passes it so the program advances its settled total.
    const logData = await new BorshAccountsCoder(VAULT_IDL).encode("IssuanceLog", {
      issued: new BN(150_000), settled: new BN(0), seq: new BN(0), updated_slot: new BN(0), updated_at: new BN(0), bump: 255,
    });
    conn.getAccountInfo = async (pk: PublicKey) => (pk.equals(issuancePda(program)) ? { owner: program, data: logData } : null);
    const preparedWithLog = await s.prepareSettlement(5n, payouts);
    expect(preparedWithLog.withIssuanceLog).toBe(true);
    await preparedWithLog.send();
    const withLog = Transaction.from(sent!).instructions[0];
    expect(withLog.keys.slice(5).map((m) => m.pubkey.toBase58())).toEqual([providerPda(2, program).toBase58(), payout.toBase58(), issuancePda(program).toBase58()]);
    expect(withLog.keys[7].isWritable).toBe(true);
    conn.getAccountInfo = async () => null;
    expect(await s.confirm("sig1")).toBe("confirmed");
    expect(await s.isExpired(500)).toBe(true);

    conn.sendRawTransaction = async () => { throw Object.assign(new Error("Simulation failed"), { logs: ["Program log: AnchorError ... Error Code: BadBatchId. Error Number: 6006."] }); };
    await expect((await s.prepareSettlement(9n, payouts)).send()).rejects.toMatchObject({ name: "ProgramError", program: "BadBatchId" });
    conn.sendRawTransaction = async () => { throw new Error("fetch failed"); };
    await expect((await s.prepareSettlement(9n, payouts)).send()).rejects.not.toBeInstanceOf(ProgramError);
    expect(programErrorFrom(new Error("Error Code: NotAnError"))).toBeNull();
    // Vault short of funds: logs as captured from the vault's LiteSVM test settle_vault_short_of_funds.
    const short = Object.assign(new Error("Simulation failed"), { logs: [
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]", "Program log: Error: insufficient funds",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1",
      `Program ${program.toBase58()} failed: custom program error: 0x1`,
    ] });
    expect(programErrorFrom(short)).toMatchObject({ name: "ProgramError", program: "InsufficientFunds" });
    expect(programErrorFrom(Object.assign(new Error("x"), { logs: ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x11"] }))).toBeNull();
  });
});
