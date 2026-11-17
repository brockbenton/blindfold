// One settlement writer per vault. `pnpm serve` and `pnpm demo` (devnet) each run a mint that signs settle_batch with
// the same mint authority; two at once can misrecord a payout (docs/DEMO.md). A lock file in the keys directory
// makes the second one refuse to start. A lock whose process is gone is stale and taken over.
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
    return info.pid !== process.pid && alive(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** Takes the lock or throws naming the holder. Returns the release function. */
export function acquireSettleLock(keysDir: string, what: string): () => void {
  const holder = lockHolder(keysDir);
  if (holder) {
    throw new Error(`${holder.what} (pid ${holder.pid}, since ${holder.started}) is already settling for this vault. Stop it first: one settlement writer at a time.`);
  }
  const p = lockPath(keysDir);
  writeFileSync(p, JSON.stringify({ pid: process.pid, what, started: new Date().toISOString() } satisfies LockInfo), { mode: 0o600 });
  return () => {
    try {
      const info = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
      if (info.pid === process.pid) rmSync(p);
    } catch { /* already gone */ }
  };
}
