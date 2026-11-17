import { afterEach, describe, expect, it, vi } from "vitest";
import { everyAligned, msToNextBoundary } from "../src/jobs/loop.js";

afterEach(() => { vi.useRealTimers(); });

describe("aligned settlement windows", () => {
  it("waits for the next UTC multiple of the period", () => {
    expect(msToNextBoundary(600_000, 1_763_166_000_000)).toBe(600_000); // on a boundary: next one
    expect(msToNextBoundary(600_000, 1_763_166_000_001)).toBe(599_999);
    expect(msToNextBoundary(60_000, 59_000)).toBe(1_000);
  });

  it("two processes started at different times run at the same moments", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_123);
    const runs: number[] = [];
    const stopA = everyAligned(10_000, "a", async () => { runs.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(3_500);
    const stopB = everyAligned(10_000, "b", async () => { runs.push(Date.now()); });
    await vi.advanceTimersByTimeAsync(20_000);
    stopA(); stopB();
    expect(runs).toEqual([1_010_000, 1_010_000, 1_020_000, 1_020_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toHaveLength(4);
  });
});
