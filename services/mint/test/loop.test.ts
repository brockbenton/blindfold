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

  it("a clock that reads just before the boundary after a run does not repeat that window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    let skew = 0;
    const runs: number[] = [];
    // After the first run the clock reads 1 ms behind, as if the timer had woken early.
    const stop = everyAligned(10_000, "early", async () => { runs.push(Date.now()); skew = runs.length === 1 ? -1 : 0; }, () => Date.now() + skew);
    await vi.advanceTimersByTimeAsync(25_000);
    stop();
    expect(runs.map((t) => Math.floor(t / 10_000))).toEqual([1, 2, 3]); // one run per window
  });
});
