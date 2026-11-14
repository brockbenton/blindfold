import { createApp } from "./app.js";
import type { SettleSender } from "./chain/settleSender.js";
import type { VaultReader } from "./chain/vaultReader.js";
import type { MemoryVault } from "./chain/memory.js";
import type { AppConfig } from "./config.js";
import type { Ctx } from "./ctx.js";
import { Keysets } from "./crypto/keyset.js";
import { migrate, type Db } from "./db.js";
import { pollDeposits } from "./jobs/depositPoller.js";
import { every } from "./jobs/loop.js";
import { syncProviders } from "./jobs/providerSync.js";
import { runSettlement } from "./jobs/settlement.js";

export interface MintDeps {
  db: Db;
  cfg: AppConfig;
  vault: VaultReader;
  sender: SettleSender;
  devVault?: MemoryVault;
  confirmTimeoutMs?: number;
}

/** Boot steps 1 to 3 (02-mint.md, Boot and jobs): migrate, keyset, first provider sync. Jobs start with `start()`. */
export async function createMint(deps: MintDeps) {
  const { db, cfg, vault, sender } = deps;
  await migrate(db);
  const keysets = await Keysets.load(db, cfg.MINT_SEED);
  const sync = () => syncProviders(db, vault, cfg.providers);
  const settleDeps = { db, vault, sender, syncProviders: sync, confirmTimeoutMs: deps.confirmTimeoutMs };
  const ctx: Ctx = {
    db, cfg, keysets, vault, devVault: deps.devVault,
    settle: () => runSettlement(settleDeps, { sync: true }),
    tick: async () => {
      await sync();
      await pollDeposits(db, vault);
    },
  };
  await sync();
  const app = createApp(ctx);

  function start(): () => void {
    const stops = [
      every(cfg.depositPollMs, "deposit-poller", () => pollDeposits(db, vault)),
      every(30_000, "provider-sync", sync),
      every(cfg.settleIntervalS * 1000, "settlement", () =>
        runSettlement({ ...settleDeps, syncProviders: undefined }).catch((e) => {
          if ((e as { status?: number }).status !== 409) throw e; // 409: already running or in flight
        })),
    ];
    return () => stops.forEach((s) => s());
  }
  return { app, ctx, start };
}
