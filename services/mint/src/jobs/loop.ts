/** setInterval that never overlaps runs and never throws. Returns a stop function. */
export function every(ms: number, name: string, fn: () => Promise<unknown>): () => void {
  let running = false;
  const t = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, (e as Error).message);
    } finally {
      running = false;
    }
  }, ms);
  t.unref();
  return () => clearInterval(t);
}

/** Milliseconds from `now` to the next UTC multiple of `periodMs` (a full period if `now` is on a boundary). */
export function msToNextBoundary(periodMs: number, now: number): number {
  return periodMs - (now % periodMs);
}

/**
 * Like `every`, but runs fire on UTC multiples of `periodMs`, so every process with the same period runs at the
 * same wall-clock moments regardless of when it started. A run that overruns a boundary skips to the next one.
 */
export function everyAligned(periodMs: number, name: string, fn: () => Promise<unknown>, clock: () => number = Date.now): () => void {
  let t: NodeJS.Timeout | undefined;
  let stopped = false;
  let last = -1; // the boundary of the previous run, so a timer that wakes a little early cannot run it twice
  const schedule = () => {
    if (stopped) return;
    const now = clock();
    let target = now + msToNextBoundary(periodMs, now);
    if (target <= last) target = last + periodMs;
    t = setTimeout(async () => {
      last = target;
      try {
        await fn();
      } catch (e) {
        console.error(`[${name}]`, (e as Error).message);
      } finally {
        schedule();
      }
    }, Math.max(0, target - now));
    t.unref();
  };
  schedule();
  return () => {
    stopped = true;
    clearTimeout(t);
  };
}
