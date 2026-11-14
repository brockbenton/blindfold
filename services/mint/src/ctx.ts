import type { AdminSettleResponse } from "@blindfold/protocol";
import type { AppConfig } from "./config.js";
import type { Db } from "./db.js";
import type { Keysets } from "./crypto/keyset.js";
import type { VaultReader } from "./chain/vaultReader.js";
import type { MemoryVault } from "./chain/memory.js";

export interface Ctx {
  db: Db;
  cfg: AppConfig;
  keysets: Keysets;
  vault: VaultReader;
  /** Runs one settlement now, syncing providers first. */
  settle(): Promise<AdminSettleResponse>;
  /** Runs one deposit poll and one provider sync now. */
  tick(): Promise<void>;
  /** Present only in dev fake-chain mode. */
  devVault?: MemoryVault;
}
