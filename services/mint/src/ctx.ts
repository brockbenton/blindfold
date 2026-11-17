import type { AdminSettleResponse } from "@blindfold/protocol";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Keysets } from "./crypto/keyset.js";
import type { VaultReader } from "./chain/vaultReader.js";
import type { MemoryVault } from "./chain/memory.js";
import type { IssuanceSyncResult } from "./jobs/issuanceLog.js";

export interface Ctx {
  db: Db;
  cfg: AppConfig;
  keysets: Keysets;
  vault: VaultReader;
  /** Runs one settlement now, syncing providers first. */
  settle(): Promise<AdminSettleResponse>;
  /** Runs one deposit poll and one provider sync now. */
  tick(): Promise<void>;
  /**
   * Polls deposits now (a hint, e.g. from a QuickNode Stream's DepositMade event). Joins a poll already in flight.
   * Deposits are still credited only from the vault's DepositRecord accounts.
   */
  pollDeposits(): Promise<number>;
  /** Publishes issuance to the onchain log now. Absent when the settlement sender cannot write the log. */
  syncIssuance?(): Promise<IssuanceSyncResult>;
  /** Present only in dev fake-chain mode. */
  devVault?: MemoryVault;
}
