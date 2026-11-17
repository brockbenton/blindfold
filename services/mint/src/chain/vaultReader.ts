import {
  SOLANA_COMMITMENT, configPda, decodeConfig, decodeDepositRecord, decodeIssuanceLog, decodeProviderRecord, depositPda, issuancePda, providerPda,
  vaultAta, type DepositRecordAccount, type IssuanceLogAccount, type ProviderRecordAccount,
} from "@blindfold/protocol";
import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";

export interface VaultConfigView {
  depositCount: bigint;
  providerCount: number;
  lastBatchId: bigint;
}

/** Everything the mint reads from the vault. Account state only, never transactions (00 section 6). */
export interface VaultReader {
  getConfig(): Promise<VaultConfigView>;
  /** One entry per index, `null` if the account does not exist yet (RPC lag). Throws on a wrong owner. */
  getDeposits(indices: bigint[]): Promise<(DepositRecordAccount | null)[]>;
  getProvider(id: number): Promise<ProviderRecordAccount | null>;
  getVaultBalanceBase(): Promise<bigint>;
  /** The onchain issuance log, or `null` before it is created. */
  getIssuanceLog(): Promise<IssuanceLogAccount | null>;
}

const CHUNK = 50;

export class SolanaVaultReader implements VaultReader {
  constructor(private connection: Connection, private programId: PublicKey, private usdcMint: PublicKey) {}

  private owned(info: AccountInfo<Buffer>, what: string): Buffer {
    if (!info.owner.equals(this.programId)) throw new Error(`${what} is not owned by the vault program`);
    return info.data;
  }

  async getConfig(): Promise<VaultConfigView> {
    const info = await this.connection.getAccountInfo(configPda(this.programId), SOLANA_COMMITMENT);
    if (!info) throw new Error("vault Config account not found");
    const c = decodeConfig(this.owned(info, "Config"));
    if (!c.usdcMint.equals(this.usdcMint)) throw new Error("vault Config usdc_mint does not match USDC_MINT");
    if (!c.vaultToken.equals(vaultAta(this.usdcMint, this.programId))) throw new Error("vault Config vault_token does not match the expected vault account");
    return { depositCount: c.depositCount, providerCount: c.providerCount, lastBatchId: c.lastBatchId };
  }

  async getDeposits(indices: bigint[]): Promise<(DepositRecordAccount | null)[]> {
    const out: (DepositRecordAccount | null)[] = [];
    for (let i = 0; i < indices.length; i += CHUNK) {
      const slice = indices.slice(i, i + CHUNK);
      const infos = await this.connection.getMultipleAccountsInfo(slice.map((n) => depositPda(n, this.programId)), SOLANA_COMMITMENT);
      infos.forEach((info, j) => {
        out.push(info ? decodeDepositRecord(this.owned(info, `DepositRecord ${slice[j]}`)) : null);
      });
    }
    return out;
  }

  async getProvider(id: number): Promise<ProviderRecordAccount | null> {
    const info = await this.connection.getAccountInfo(providerPda(id, this.programId), SOLANA_COMMITMENT);
    return info ? decodeProviderRecord(this.owned(info, `ProviderRecord ${id}`)) : null;
  }

  async getIssuanceLog(): Promise<IssuanceLogAccount | null> {
    const info = await this.connection.getAccountInfo(issuancePda(this.programId), SOLANA_COMMITMENT);
    return info ? decodeIssuanceLog(this.owned(info, "IssuanceLog")) : null;
  }

  async getVaultBalanceBase(): Promise<bigint> {
    const bal = await this.connection.getTokenAccountBalance(vaultAta(this.usdcMint, this.programId), SOLANA_COMMITMENT);
    return BigInt(bal.value.amount);
  }
}
