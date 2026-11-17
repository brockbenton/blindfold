import { createApp } from "./app.js";
import { isIssuanceWriter, type SettleSender } from "./chain/settleSender.js";
import type { VaultReader } from "./chain/vaultReader.js";
import type { MemoryVault } from "./chain/memory.js";
import type { AppConfig } from "./config.js";
import type { Ctx } from "./ctx.js";
import { Keysets } from "./crypto/keyset.js";
import { migrate, type Db } from "./db.js";
import { pollDeposits } from "./jobs/depositPoller.js";
import { syncIssuanceLog, type IssuanceSyncResult } from "./jobs/issuanceLog.js";
import { every, everyAligned } from "./jobs/loop.js";
import { syncProviders } from "./jobs/providerSync.js";
import { runSettlement } from "./jobs/settlement.js";

export type Job = "deposits" | "providers" | "settlement" | "issuance";

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
  const settleDeps = {
    db, vault, sender, syncProviders: sync, confirmTimeoutMs: deps.confirmTimeoutMs,
    holdS: cfg.settleHoldS ?? 0, unitCents: cfg.settleUnitCents ?? 1,
  };
  // One poll at a time: the timer and Stream hints share it, so a burst of hints costs one RPC round.
  let polling: Promise<number> | null = null;
  const pollNow = () => (polling ??= pollDeposits(db, vault).finally(() => { polling = null; }));
  const writer = isIssuanceWriter(sender) ? sender : undefined;
  // Likewise one issuance-log write at a time, so the timer and the admin route never both try to create the log.
  let logging: Promise<IssuanceSyncResult> | null = null;
  const ctx: Ctx = {
    db, cfg, keysets, vault, devVault: deps.devVault,
    settle: () => runSettlement(settleDeps, { sync: true }),
    tick: async () => {
      await sync();
      await pollNow();
    },
    pollDeposits: pollNow,
    ...(writer ? { syncIssuance: () => (logging ??= syncIssuanceLog({ db, vault, writer, confirmTimeoutMs: deps.confirmTimeoutMs }).finally(() => { logging = null; })) } : {}),
  };
  await sync();
  const app = createApp(ctx);

  /** Starts the background jobs, or only the named ones (a demo can keep settlement running and stop polling). */
  function start(jobs: readonly Job[] = ["deposits", "providers", "settlement", "issuance"]): () => void {
    const stops: (() => void)[] = [];
    if (jobs.includes("deposits")) stops.push(every(cfg.depositPollMs, "deposit-poller", pollNow));
    const logMs = cfg.issuanceLogMs ?? 5000;
    if (jobs.includes("issuance") && ctx.syncIssuance && logMs > 0) {
      const syncLog = ctx.syncIssuance;
      let warned = false;
      const stop = every(logMs, "issuance-log", async () => {
        if ((await syncLog()) === "unsupported" && !warned) {
          warned = true;
          console.warn("[issuance-log] the vault program has no issuance log instructions (upgrade it); agents fall back to the mint's report");
        }
      });
      stops.push(stop);
    }
    if (jobs.includes("providers")) stops.push(every(30_000, "provider-sync", sync));
    if (jobs.includes("settlement")) {
      stops.push(everyAligned(cfg.settleIntervalS * 1000, "settlement", () =>
        runSettlement({ ...settleDeps, syncProviders: undefined }).catch((e) => {
          if ((e as { status?: number }).status !== 409) throw e; // 409: already running or in flight
        })));
    }
    return () => stops.forEach((s) => s());
  }
  return { app, ctx, start };
}
