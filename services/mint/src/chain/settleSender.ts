import { PublicKey, Transaction, Keypair, type Connection } from "@solana/web3.js";
import { SOLANA_COMMITMENT, VAULT_IDL, buildSettleBatchIx } from "@blindfold/protocol";

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
  /** Sends `settle_batch`. Returns the tx signature and a validity bound for `isExpired`. Throws ProgramError on a program rejection; any other throw is transient. */
  submit(batchId: bigint, payouts: SettlePayout[]): Promise<{ tx: string; validUntil: number }>;
  confirm(tx: string): Promise<ConfirmStatus>;
  /** True once the transaction can no longer land. */
  isExpired(validUntil: number): Promise<boolean>;
}

const errorNames = new Set((VAULT_IDL.errors ?? []).map((e) => e.name));

/** Finds an Anchor error name in simulation logs or the message. */
export function programErrorFrom(e: unknown): ProgramError | null {
  const logs = (e as { logs?: string[] })?.logs ?? [];
  const text = [...logs, (e as Error)?.message ?? ""].join("\n");
  const m = /Error Code: (\w+)/.exec(text);
  if (m && errorNames.has(m[1])) return new ProgramError(m[1], text.slice(0, 500));
  return null;
}

export class SolanaSettleSender implements SettleSender {
  constructor(
    private connection: Connection,
    private programId: PublicKey,
    private usdcMint: PublicKey,
    private authority: Keypair,
  ) {}

  async submit(batchId: bigint, payouts: SettlePayout[]) {
    const ix = buildSettleBatchIx({
      programId: this.programId,
      mintAuthority: this.authority.publicKey,
      usdcMint: this.usdcMint,
      batchId,
      payouts: payouts.map((p) => ({ providerId: p.providerId, amount: p.amountBase, payoutToken: new PublicKey(p.payoutToken) })),
    });
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(SOLANA_COMMITMENT);
    const tx = new Transaction({ feePayer: this.authority.publicKey, blockhash, lastValidBlockHeight }).add(ix);
    tx.sign(this.authority);
    try {
      const tx_sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: SOLANA_COMMITMENT });
      return { tx: tx_sig, validUntil: lastValidBlockHeight };
    } catch (e) {
      throw programErrorFrom(e) ?? e;
    }
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
    return (await this.connection.getBlockHeight(SOLANA_COMMITMENT)) > validUntil;
  }
}
