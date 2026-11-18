// One settlement writer per vault. `pnpm serve` and `pnpm demo` (devnet) each run a mint that signs settle_batch with
// the same mint authority; two at once can misrecord a payout (docs/DEMO.md). A lock file in the keys directory
// makes the second one refuse to start. The owner releases it on a normal exit.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockInfo { pid: number; what: string; started: string }

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const lockPath = (keysDir: string) => join(keysDir, ".settlement-writer.lock");

/** The live lock holder, if any (a stale lock reads as none). */
export function lockHolder(keysDir: string): LockInfo | null {
  const p = lockPath(keysDir);
  if (!existsSync(p)) return null;
  try {
    const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
    return Number.isSafeInteger(info.pid) && info.pid > 0 && alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** Takes the lock or throws naming the holder. Returns the release function. */
export function acquireSettleLock(keysDir: string, what: string): () => void {
  const p = lockPath(keysDir);
  try {
    writeFileSync(p, JSON.stringify({ pid: process.pid, what, started: new Date().toISOString() } satisfies LockInfo), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = lockHolder(keysDir);
    if (holder) {
      throw new Error(`${holder.what} (pid ${holder.pid}, since ${holder.started}) is already settling for this vault. Stop it first.`);
    }
    // Probing and unlinking a stale pathname can delete a different process's new lock.
    throw new Error(`Settlement lock exists at ${p}. Verify its owner has stopped before removing it.`);
  }

  let held = true;
  function release() {
    if (!held) return;
    held = false;
    process.off("exit", release);
    try {
      const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
      if (info.pid === process.pid) rmSync(p);
    } catch { /* already gone */ }
  }
  process.once("exit", release);
  return release;
}
