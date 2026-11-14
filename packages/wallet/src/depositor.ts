import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SOLANA_COMMITMENT, buildDepositIx, centsToBaseUnits, configPda, decodeConfig } from "@blindfold/protocol";

export interface Depositor {
  deposit(a: { amountCents: number; depositRef: Uint8Array }): Promise<{ signature: string }>;
}

/** Sends the vault `deposit` instruction. Not covered by unit tests until the vault exists. */
export class SolanaDepositor implements Depositor {
  private connection: Connection;
  constructor(private o: { rpcUrl: string; owner: Keypair; programId: PublicKey; usdcMint: PublicKey }) {
    this.connection = new Connection(o.rpcUrl, SOLANA_COMMITMENT);
  }

  async deposit(a: { amountCents: number; depositRef: Uint8Array }): Promise<{ signature: string }> {
    const { owner, programId, usdcMint } = this.o;
    let lastErr: unknown;
    // Two deposits built on the same deposit_count collide on the DepositRecord seed: rebuild and resend.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const info = await this.connection.getAccountInfo(configPda(programId), SOLANA_COMMITMENT);
        if (!info) throw new Error("vault Config account not found");
        const config = decodeConfig(info.data);
        const ix = buildDepositIx({
          programId,
          depositor: owner.publicKey,
          depositorToken: getAssociatedTokenAddressSync(usdcMint, owner.publicKey),
          usdcMint,
          amount: centsToBaseUnits(a.amountCents),
          depositRef: a.depositRef,
          depositIndex: config.depositCount,
        });
        const signature = await sendAndConfirmTransaction(this.connection, new Transaction().add(ix), [owner], {
          commitment: SOLANA_COMMITMENT,
        });
        return { signature };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`deposit failed after 3 attempts: ${(lastErr as Error).message}`);
  }
}
