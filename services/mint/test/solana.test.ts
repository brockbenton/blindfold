// The Solana-backed classes against a fake Connection (no validator).
import { BN, BorshAccountsCoder } from "@anchor-lang/core";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { PLACEHOLDER_VAULT_PROGRAM_ID, USDC_DEVNET_MINT, VAULT_IDL, configPda, decodeInstruction, depositPda, providerPda } from "@blindfold/protocol";
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
      data: await coder.encode("Config", { admin: k(), mint_authority: k(), usdc_mint: usdc, vault_token: k(), max_deposit: bn(5), deposit_count: bn(2), provider_count: 1, last_batch_id: bn(3), bump: 1 }),
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
  });
});

describe("SolanaSettleSender", () => {
  it("builds a signed settle_batch with provider/payout account pairs and maps program errors", async () => {
    const authority = Keypair.generate();
    const payout = k();
    let sent: Buffer | undefined;
    const conn: any = {
      getLatestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 500 }),
      sendRawTransaction: async (raw: Buffer) => { sent = raw; return "sig1"; },
      getSignatureStatuses: async () => ({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      getBlockHeight: async () => 501,
    };
    const s = new SolanaSettleSender(conn, program, usdc, authority);
    expect(await s.submit(4n, [{ providerId: 2, payoutToken: payout.toBase58(), amountBase: 150_000n }])).toEqual({ tx: "sig1", validUntil: 500 });
    const tx = Transaction.from(sent!);
    expect(tx.feePayer?.equals(authority.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    const ix = tx.instructions[0];
    const dec = decodeInstruction(ix.data)!;
    expect(dec.name).toBe("settle_batch");
    expect(ix.keys.slice(5).map((m) => m.pubkey.toBase58())).toEqual([providerPda(2, program).toBase58(), payout.toBase58()]);
    expect(await s.confirm("sig1")).toBe("confirmed");
    expect(await s.isExpired(500)).toBe(true);

    conn.sendRawTransaction = async () => { throw Object.assign(new Error("Simulation failed"), { logs: ["Program log: AnchorError ... Error Code: BadBatchId. Error Number: 6006."] }); };
    await expect(s.submit(9n, [{ providerId: 2, payoutToken: payout.toBase58(), amountBase: 10_000n }])).rejects.toMatchObject({ name: "ProgramError", program: "BadBatchId" });
    conn.sendRawTransaction = async () => { throw new Error("fetch failed"); };
    await expect(s.submit(9n, [{ providerId: 2, payoutToken: payout.toBase58(), amountBase: 10_000n }])).rejects.not.toBeInstanceOf(ProgramError);
    expect(programErrorFrom(new Error("Error Code: NotAnError"))).toBeNull();
  });
});
