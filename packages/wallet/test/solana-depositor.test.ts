// SolanaDepositor resend rules: never deposit twice when a send's outcome is unknown.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, SendTransactionError, Transaction } from "@solana/web3.js";
import { decodeInstruction, depositPda } from "@blindfold/protocol";
import { SolanaDepositor, type DepositConnection } from "../src/depositor.js";

const programId = Keypair.generate().publicKey;
const usdcMint = Keypair.generate().publicKey;
const owner = Keypair.generate();
const ref = new Uint8Array(32).fill(7);

function configData(depositCount: number): Buffer {
  const disc = createHash("sha256").update("account:Config").digest().subarray(0, 8);
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const k = () => Keypair.generate().publicKey.toBuffer();
  return Buffer.concat([disc, k(), k(), usdcMint.toBuffer(), k(), u64(50_000_000), u64(depositCount), Buffer.alloc(4), u64(0), Buffer.from([255])]);
}

type Status = { err: unknown; confirmationStatus: string } | null;
interface Script {
  /** Per send: throw this error (after optionally landing), or land with a status. */
  send: ({ throws?: Error; status?: Status })[];
}

function fakeConnection(s: Script) {
  let count = 0;
  let height = 100;
  const statuses = new Map<string, Status>();
  const sent: { sig: string; index: number }[] = [];
  const conn: DepositConnection = {
    getAccountInfo: (async () => ({ owner: programId, data: configData(count), executable: false, lamports: 1 })) as never,
    getLatestBlockhash: (async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + 5 })) as never,
    sendRawTransaction: (async (raw: Buffer) => {
      const tx = Transaction.from(raw);
      const b58 = encode(tx.signatures[0].signature!);
      const step = s.send[sent.length] ?? {};
      expect(decodeInstruction(tx.instructions[0].data)?.name).toBe("deposit");
      // Every attempt is built against the deposit_count current at build time.
      expect(tx.instructions[0].keys[2].pubkey.equals(depositPda(count, programId))).toBe(true);
      sent.push({ sig: b58, index: count });
      if (step.status !== undefined) {
        statuses.set(b58, step.status);
        if (step.status && !step.status.err) count++;
      }
      if (step.throws) throw step.throws;
      return b58;
    }) as never,
    getSignatureStatuses: (async (sigs: string[]) => ({ context: { slot: 1 }, value: sigs.map((x) => statuses.get(x) ?? null) })) as never,
    getBlockHeight: (async () => (height += 3)) as never,
  };
  return { conn, sent, landed: () => count };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

const make = (conn: DepositConnection) => new SolanaDepositor({ rpcUrl: "http://unused", owner, programId, usdcMint, connection: conn, pollMs: 1 });
const confirmed = { err: null, confirmationStatus: "confirmed" };
const preflight = () => new SendTransactionError({ action: "send", signature: "", transactionMessage: "Simulation failed: ConstraintSeeds", logs: [] });

describe("SolanaDepositor", () => {
  it("returns the signature of a confirmed deposit", async () => {
    const f = fakeConnection({ send: [{ status: confirmed }] });
    const r = await make(f.conn).deposit({ amountCents: 100, depositRef: ref });
    expect(f.sent).toHaveLength(1);
    expect(r.signature).toBe(f.sent[0].sig);
  });

  it("does not resend when the send errors but the tx landed (no double deposit)", async () => {
    const f = fakeConnection({ send: [{ status: confirmed, throws: new TypeError("fetch failed") }] });
    const r = await make(f.conn).deposit({ amountCents: 100, depositRef: ref });
    expect(f.sent).toHaveLength(1);
    expect(f.landed()).toBe(1);
    expect(r.signature).toBe(f.sent[0].sig);
  });

  it("rebuilds with the new deposit_count after a preflight rejection (seed collision)", async () => {
    const f = fakeConnection({ send: [{ throws: preflight() }, { status: confirmed }] });
    const r = await make(f.conn).deposit({ amountCents: 100, depositRef: ref });
    expect(f.sent).toHaveLength(2);
    expect(r.signature).toBe(f.sent[1].sig);
  });

  it("resends after an onchain failure, which moved no funds", async () => {
    const f = fakeConnection({ send: [{ status: { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" } }, { status: confirmed }] });
    const r = await make(f.conn).deposit({ amountCents: 100, depositRef: ref });
    expect(f.sent).toHaveLength(2);
    expect(r.signature).toBe(f.sent[1].sig);
    expect(f.landed()).toBe(1);
  });

  it("waits for the blockhash to expire before resending a tx whose fate is unknown", async () => {
    const f = fakeConnection({ send: [{ throws: new TypeError("fetch failed") }, { status: confirmed }] });
    const r = await make(f.conn).deposit({ amountCents: 100, depositRef: ref });
    expect(f.sent).toHaveLength(2);
    expect(r.signature).toBe(f.sent[1].sig);
    expect(f.landed()).toBe(1);
  });

  it("gives up after 3 provably failed attempts", async () => {
    const f = fakeConnection({ send: [{ throws: preflight() }, { throws: preflight() }, { throws: preflight() }] });
    await expect(make(f.conn).deposit({ amountCents: 100, depositRef: ref })).rejects.toThrow(/after 3 attempts/);
    expect(f.landed()).toBe(0);
  });
});
