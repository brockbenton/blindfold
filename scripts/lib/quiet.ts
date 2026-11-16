// Import first in demo entry points. Drops library noise that would clutter a recorded terminal:
// web3.js rate-limit retry lines (it still retries) and the bigint-buffer native-binding notice.
const noise = [/^Server responded with 429/, /^bigint: Failed to load bindings/];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    if (typeof args[0] === "string" && noise.some((r) => r.test(args[0] as string))) return;
    orig(...args);
  };
}
export {};
