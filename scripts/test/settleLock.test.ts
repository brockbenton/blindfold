import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSettleLock, lockHolder, lockPath } from "../lib/settleLock.js";

const dir = () => mkdtempSync(join(tmpdir(), "bf-lock-"));

describe("settlement writer lock", () => {
  it("takes, reports and releases the lock", () => {
    const d = dir();
    const release = acquireSettleLock(d, "pnpm serve");
    expect(existsSync(lockPath(d))).toBe(true);
    expect(lockHolder(d)?.pid).toBe(process.pid);
    expect(() => acquireSettleLock(d, "pnpm demo")).toThrow(/pnpm serve .* already settling/);
    release();
    expect(existsSync(lockPath(d))).toBe(false);
  });

  it("refuses while another live process holds it", () => {
    const d = dir();
    // The parent process stands in for another live writer.
    writeFileSync(lockPath(d), JSON.stringify({ pid: process.ppid, what: "pnpm demo", started: "2026-11-17T00:00:00Z" }));
    expect(() => acquireSettleLock(d, "pnpm serve")).toThrow(/pnpm demo .* already settling/);
  });

  it("preserves a stale lock until an operator verifies it", () => {
    const d = dir();
    writeFileSync(lockPath(d), JSON.stringify({ pid: 2 ** 22 + 12345, what: "pnpm demo", started: "2026-11-17T00:00:00Z" }));
    expect(lockHolder(d)).toBeNull();
    const before = readFileSync(lockPath(d), "utf8");
    expect(() => acquireSettleLock(d, "pnpm serve")).toThrow(/Verify its owner has stopped/);
    expect(readFileSync(lockPath(d), "utf8")).toBe(before);
  });
});
