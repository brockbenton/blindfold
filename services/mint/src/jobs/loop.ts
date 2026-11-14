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
