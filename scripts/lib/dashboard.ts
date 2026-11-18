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
  | { type: "observer"; side: "exact" | "blindfold"; action: string; reason: string; tone: "alarm" | "calm" }
  | { type: "balances"; agentTokensCents: number; exactWalletBase: string; providerDirectBase: string; providerSettledBase: string; providerOwedCents: number; vaultBase: string }
  | { type: "reserve"; ok: boolean; verified: boolean; text: string; detail: string; url?: string }
  | { type: "source"; text: string }
  | { type: "note"; side: "exact" | "blindfold"; tone: "ok" | "warn"; text: string }
  // Act 5's attribution scoreboard (scripts/lib/attribution.ts). `text` is the whole board in one line, which a page
  // without a `score` handler shows as a plain note.
  | { type: "score"; text: string; visible: string; sides: Record<"exact" | "blindfold", ScoreView> }
  | { type: "approval"; id: string; cents: number; thresholdCents: number; label: string; timeoutS: number }
  | { type: "approval_done"; id: string; outcome: "approved" | "denied" | "timeout" }
  | { type: "done"; ok: boolean };
// New event types are fine: the page ignores types it has no handler for (see scripts/dashboard/dashboard.js).

/** One side of the scoreboard, as the page shows it. */
export interface ScoreView {
  purchases: number; transfers: number; correct: number; partial: number; incorrect: number; abstained: number;
  complete: boolean; verdict: string; summary: string;
}

export interface Dashboard<E extends { type: string } = DashboardEvent> {
  url: string;
  emit(e: E): void;
  /** Events so far (for tests). */
  readonly history: (E & { seq: number })[];
  close(): Promise<void>;
}

export const DASHBOARD_DIR = new URL("../dashboard/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json" };
/** Files shared by the live dashboards (main demo and crowd) and the replay page. */
export const SHARED_ASSETS = ["dashboard.css", "dashboard.js", "crowd.css", "crowd-dashboard.js"];

/** Serves a file from scripts/dashboard/ (read per request, so edits show on reload). */
export function serveAsset(app: Hono, path: string, file: string | URL) {
  const type = TYPES[String(file).split(".").pop()!] ?? "application/octet-stream";
  app.get(path, (c) => c.body(readFileSync(typeof file === "string" ? new URL(file, DASHBOARD_DIR) : file), 200, { "content-type": type, "cache-control": "no-store" }));
}

/**
 * `page` is a file in scripts/dashboard (default index.html, the main demo's page); `pnpm crowd` serves crowd.html.
 * `onApproval` receives the owner's Approve/Deny clicks; it returns false when the request is no longer pending.
 * `onEmit` sees every event as it is emitted (the demo's recorder for the replay page).
 */
export async function startDashboard<E extends { type: string } = DashboardEvent>(o: {
  port: number; hostname?: string; page?: string; onApproval?: (id: string, approve: boolean) => boolean;
  onEmit?: (e: E & { seq: number }) => void;
}): Promise<Dashboard<E>> {
  const history: (E & { seq: number })[] = [];
  const listeners = new Set<(e: E & { seq: number }) => void>();
  const app = new Hono();
  serveAsset(app, "/", o.page ?? "index.html");
  for (const f of SHARED_ASSETS) serveAsset(app, `/${f}`, f);
  // JSON only: a cross-site form cannot send it without a CORS preflight, which this server never answers.
  app.post("/approval/:id", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json")) return c.json({ error: "json only" }, 415);
    const body = (await c.req.json().catch(() => null)) as { approve?: unknown } | null;
    if (typeof body?.approve !== "boolean") return c.json({ error: "approve must be a boolean" }, 400);
    return o.onApproval?.(c.req.param("id"), body.approve) ? c.json({ ok: true }) : c.json({ error: "not pending" }, 404);
  });
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: (E & { seq: number })[] = [...history];
      let wake: (() => void) | null = null;
      const push = (e: E & { seq: number }) => { queue.push(e); wake?.(); };
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
