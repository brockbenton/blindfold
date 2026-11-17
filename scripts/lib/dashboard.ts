// Live dashboard for the demo: serves one static page and streams demo events to it over Server-Sent Events.
// Every event is kept, so a browser opened (or reloaded) mid-run replays the story so far. The page's renderer is
// shared with the replay page (scripts/dashboard/replay.html), which plays a recording of these events.
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export type DashboardEvent =
  | { type: "setup"; mode: "devnet" | "localnet"; topic: string; prices: { whaleFlow: number; depth: number }; exactWallet: string; vault: string; provider: string; links: Record<string, string> }
  | { type: "act"; n: number; title: string }
  | { type: "call"; side: "exact" | "blindfold"; n: number; cents: number; label: string; ok: boolean; tx?: string; url?: string }
  | { type: "chain"; side: "exact" | "blindfold"; kind: string; text: string; amountBase: string; from: string; memo?: string; time: string | null; url: string; signature: string }
  | { type: "copycat"; side: "exact" | "blindfold"; action: string; reason: string; tone: "alarm" | "calm" }
  | { type: "balances"; agentTokensCents: number; exactWalletBase: string; providerDirectBase: string; providerSettledBase: string; providerOwedCents: number; vaultBase: string }
  | { type: "note"; side: "exact" | "blindfold"; tone: "ok" | "warn"; text: string }
  | { type: "done"; ok: boolean };
// New event types are fine: the page ignores types it has no handler for (see scripts/dashboard/dashboard.js).

export interface Dashboard {
  url: string;
  emit(e: DashboardEvent): void;
  /** Events so far (for tests). */
  readonly history: (DashboardEvent & { seq: number })[];
  close(): Promise<void>;
}

export const DASHBOARD_DIR = new URL("../dashboard/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json" };
/** Files shared by the live dashboard and the replay page. */
export const SHARED_ASSETS = ["dashboard.css", "dashboard.js"];

/** Serves a file from scripts/dashboard/ (read per request, so edits show on reload). */
export function serveAsset(app: Hono, path: string, file: string | URL) {
  const type = TYPES[String(file).split(".").pop()!] ?? "application/octet-stream";
  app.get(path, (c) => c.body(readFileSync(typeof file === "string" ? new URL(file, DASHBOARD_DIR) : file), 200, { "content-type": type, "cache-control": "no-store" }));
}

export async function startDashboard(o: { port: number; hostname?: string; onEmit?: (e: DashboardEvent & { seq: number }) => void }): Promise<Dashboard> {
  const history: (DashboardEvent & { seq: number })[] = [];
  const listeners = new Set<(e: DashboardEvent & { seq: number }) => void>();
  const app = new Hono();
  serveAsset(app, "/", "index.html");
  for (const f of SHARED_ASSETS) serveAsset(app, `/${f}`, f);
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: (DashboardEvent & { seq: number })[] = [...history];
      let wake: (() => void) | null = null;
      const push = (e: DashboardEvent & { seq: number }) => { queue.push(e); wake?.(); };
      listeners.add(push);
      stream.onAbort(() => { listeners.delete(push); wake?.(); });
      while (!stream.aborted) {
        const e = queue.shift();
        if (e) await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) });
        else await Promise.race([new Promise<void>((r) => { wake = r; }), stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }))]);
        wake = null;
      }
      listeners.delete(push);
    }),
  );
  const server = serve({ fetch: app.fetch, port: o.port, hostname: o.hostname ?? "127.0.0.1" });
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://localhost:${port}`,
    history,
    emit(e) {
      const ev = { ...e, seq: history.length + 1 };
      history.push(ev);
      o.onEmit?.(ev);
      for (const l of listeners) l(ev);
    },
    close: () => new Promise<void>((r) => { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); server.close(() => r()); }),
  };
}
