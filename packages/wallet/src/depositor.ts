import { Connection, Keypair, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { SOLANA_COMMITMENT, buildDepositIx, centsToBaseUnits, configPda, decodeConfig } from "@blindfold/protocol";

export interface Depositor {
  deposit(a: { amountCents: number; depositRef: Uint8Array }): Promise<{ signature: string }>;
}

/** The Connection methods SolanaDepositor uses (injectable for tests). */
export type DepositConnection = Pick<
  Connection,
  "getAccountInfo" | "getLatestBlockhash" | "sendRawTransaction" | "getSignatureStatuses" | "getBlockHeight"
>;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Outcome = "landed" | "failed" | "expired";

/**
 * Sends the vault `deposit` instruction (04 section 5.6 step 3).
 *
 * Two deposits built on the same `deposit_count` collide on the DepositRecord seed, so a failed attempt is rebuilt
 * with the new count and resent, up to 3 times. A resend happens only when the earlier attempt provably moved no
 * funds: the RPC rejected it (preflight), it failed onchain, or its blockhash expired without it landing. If the
 * outcome cannot be determined the deposit throws with the signature instead of resending, so USDC is never
 * deposited twice.
 */
export class SolanaDepositor implements Depositor {
  private connection: DepositConnection;
  private pollMs: number;
  constructor(private o: {
    rpcUrl: string; owner: Keypair; programId: PublicKey; usdcMint: PublicKey;
    connection?: DepositConnection; pollMs?: number;
  }) {
    this.connection = o.connection ?? new Connection(o.rpcUrl, SOLANA_COMMITMENT);
    this.pollMs = o.pollMs ?? 500;
  }

  async deposit(a: { amountCents: number; depositRef: Uint8Array }): Promise<{ signature: string }> {
    const { owner, programId, usdcMint } = this.o;
    const c = this.connection;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      const info = await c.getAccountInfo(configPda(programId), SOLANA_COMMITMENT);
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
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash(SOLANA_COMMITMENT);
      const tx = new Transaction({ feePayer: owner.publicKey, blockhash, lastValidBlockHeight }).add(ix);
      tx.sign(owner);
      const signature = base58(tx.signature!);

      try {
        await c.sendRawTransaction(tx.serialize(), { preflightCommitment: SOLANA_COMMITMENT });
      } catch (e) {
        // The RPC answered with an error (preflight simulation failed, e.g. a seed collision): the tx was not
        // forwarded and moved nothing, so rebuilding is safe.
        if (e instanceof SendTransactionError) {
          lastErr = e;
          continue;
        }
        // Anything else (network error, timeout): the tx may still have been forwarded. Find out before resending.
      }

      const outcome = await this.outcome(signature, lastValidBlockHeight);
      if (outcome === "landed") return { signature };
      lastErr = new Error(`deposit tx ${signature} ${outcome === "failed" ? "failed onchain" : "expired without landing"}`);
    }
    throw new Error(`deposit failed after 3 attempts: ${(lastErr as Error).message}`);
  }

  /** Polls until the tx is confirmed, failed onchain, or can no longer land. */
  private async outcome(signature: string, lastValidBlockHeight: number): Promise<Outcome> {
    const c = this.connection;
    for (;;) {
      const s = await this.status(signature);
      if (s) return s;
      let expired = false;
      try {
        expired = (await c.getBlockHeight(SOLANA_COMMITMENT)) > lastValidBlockHeight;
      } catch { /* RPC trouble: keep polling */ }
      if (expired) return (await this.status(signature)) ?? "expired";
      await sleep(this.pollMs);
    }
  }

  private async status(signature: string): Promise<Exclude<Outcome, "expired"> | null> {
    try {
      const { value } = await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const s = value[0];
      if (!s) return null;
      if (s.err) return "failed";
      return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "landed" : null;
    } catch {
      return null;
    }
  }
}

/** Dev only: asks a mint started with MINT_DEV_FAKE_CHAIN=1 to record a deposit (admin-protected /dev/deposit). No Solana involved. */
export class DevDepositor implements Depositor {
  constructor(private o: { mintUrl: string; adminToken: string; fetch?: typeof fetch }) {}

  async deposit(a: { amountCents: number; depositRef: Uint8Array }): Promise<{ signature: string }> {
    const f = this.o.fetch ?? fetch;
    const res = await f(`${this.o.mintUrl.replace(/\/+$/, "")}/dev/deposit`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.o.adminToken}` },
      body: JSON.stringify({ deposit_ref: Buffer.from(a.depositRef).toString("hex"), amount_cents: a.amountCents }),
    });
    if (res.status === 404) throw new Error("mint has no /dev/deposit: it is not running with MINT_DEV_FAKE_CHAIN=1, so --dev-deposit cannot be used");
    if (res.status === 401) throw new Error("mint rejected MINT_ADMIN_TOKEN for /dev/deposit");
    if (!res.ok) throw new Error(`dev deposit failed: HTTP ${res.status}`);
    const j = (await res.json()) as { index?: number };
    return { signature: `dev-deposit-${j.index ?? "?"}` };
  }
}
