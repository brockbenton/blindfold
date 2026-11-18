import { randomBytes } from "node:crypto";
import { PublicKey, Transaction, Keypair, TransactionInstruction, type Connection } from "@solana/web3.js";
import {
  SOLANA_COMMITMENT, VAULT_IDL, buildInitIssuanceLogIx, buildLogIssuanceIx, buildSettleBatchIx, issuancePda, readIssuanceLog,
} from "@blindfold/protocol";

export interface SettlePayout {
  providerId: number;
  payoutToken: string;
  amountBase: bigint;
}

/** The program rejected the transaction deterministically (BadBatchId, ProviderInactive, ...). Resending cannot help. */
export class ProgramError extends Error {
  constructor(public program: string, detail?: string) {
    super(detail ?? program);
    this.name = "ProgramError";
  }
}

export type ConfirmStatus = "confirmed" | "pending" | "failed";

export interface SettleSender {
  /** Signs a unique settlement so recovery can identify this writer's payout. */
  prepareSettlement(batchId: bigint, payouts: SettlePayout[]): Promise<PreparedTx & { withIssuanceLog: boolean }>;
  confirm(tx: string): Promise<ConfirmStatus>;
  /** True once the transaction can no longer land. */
  isExpired(validUntil: number): Promise<boolean>;
}

/** A signed transaction whose signature is known before it is sent, so the caller can record it first. */
export interface PreparedTx {
  sig: string;
  /** Block height after which it can no longer land (see `isExpired`). */
  validUntil: number;
  /** Sends it. Throws with simulation `logs` on a preflight rejection. */
  send(): Promise<void>;
}

/** Writes the vault's issuance log (base units). */
export interface IssuanceWriter {
  prepareInitIssuanceLog(issuedBase: bigint, settledBase: bigint): Promise<PreparedTx>;
  prepareLogIssuance(addBase: bigint): Promise<PreparedTx>;
  confirm(tx: string): Promise<ConfirmStatus>;
  isExpired(validUntil: number): Promise<boolean>;
}

export function isIssuanceWriter(x: unknown): x is IssuanceWriter {
  return typeof (x as IssuanceWriter)?.prepareInitIssuanceLog === "function" && typeof (x as IssuanceWriter)?.prepareLogIssuance === "function";
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (the encoding of Solana transaction signatures). */
export function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const errorNames = new Set((VAULT_IDL.errors ?? []).map((e) => e.name));

/** Finds an Anchor error name in simulation logs or the message. */
export function programErrorFrom(e: unknown): ProgramError | null {
  const logs = (e as { logs?: string[] })?.logs ?? [];
  const text = [...logs, (e as Error)?.message ?? ""].join("\n");
  const m = /Error Code: (\w+)/.exec(text);
  if (m && errorNames.has(m[1])) return new ProgramError(m[1], text.slice(0, 500));
  // The SPL Token program rejecting the transfer (vault short of funds) is just as deterministic (02 section 4.8).
  if (/Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1\b/.test(text)) {
    return new ProgramError("InsufficientFunds", text.slice(0, 500));
  }
  return null;
}

export class SolanaSettleSender implements SettleSender, IssuanceWriter {
  constructor(
    private connection: Connection,
    private programId: PublicKey,
    private usdcMint: PublicKey,
    private authority: Keypair,
  ) {}

  async prepareSettlement(batchId: bigint, payouts: SettlePayout[]) {
    // With the issuance log present, the program adds this batch to the log's settled total.
    const log = await this.connection.getAccountInfo(issuancePda(this.programId), SOLANA_COMMITMENT);
    const withIssuanceLog = readIssuanceLog(log, this.programId) !== null;
    const ix = buildSettleBatchIx({
      programId: this.programId,
      mintAuthority: this.authority.publicKey,
      usdcMint: this.usdcMint,
      batchId,
      payouts: payouts.map((p) => ({ providerId: p.providerId, amount: p.amountBase, payoutToken: new PublicKey(p.payoutToken) })),
      withIssuanceLog,
    });
    const tx = await this.prepare(ix);
    return { ...tx, withIssuanceLog, send: async () => {
      try {
        await tx.send();
      } catch (e) {
        throw programErrorFrom(e) ?? e;
      }
    } };
  }

  prepareInitIssuanceLog(issuedBase: bigint, settledBase: bigint) {
    return this.prepare(buildInitIssuanceLogIx({ programId: this.programId, mintAuthority: this.authority.publicKey, issued: issuedBase, settled: settledBase }));
  }

  prepareLogIssuance(addBase: bigint) {
    return this.prepare(buildLogIssuanceIx({ programId: this.programId, mintAuthority: this.authority.publicKey, add: addBase }));
  }

  private async prepare(ix: TransactionInstruction): Promise<PreparedTx> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(SOLANA_COMMITMENT);
    // Independent mints can sign identical instructions against the same blockhash and authority.
    const nonce = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [], data: Buffer.from(randomBytes(16).toString("hex")),
    });
    const tx = new Transaction({ feePayer: this.authority.publicKey, blockhash, lastValidBlockHeight }).add(ix, nonce);
    tx.sign(this.authority);
    const raw = tx.serialize();
    return {
      sig: base58(tx.signature!),
      validUntil: lastValidBlockHeight,
      send: async () => { await this.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: SOLANA_COMMITMENT }); },
    };
  }

  async confirm(tx: string): Promise<ConfirmStatus> {
    const { value } = await this.connection.getSignatureStatuses([tx], { searchTransactionHistory: true });
    const s = value[0];
    if (!s) return "pending";
    // A processed failure can still disappear with its fork. Do not restore
    // provider balances until the error reaches our confirmation commitment.
    if (s.confirmationStatus !== "confirmed" && s.confirmationStatus !== "finalized") return "pending";
    if (s.err) return "failed";
    return "confirmed";
  }

  async isExpired(validUntil: number): Promise<boolean> {
    return (await this.connection.getBlockHeight("finalized")) > validUntil;
  }
}
