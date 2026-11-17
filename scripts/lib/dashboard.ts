// Live dashboard for the demo: serves one static page and streams demo events to it over Server-Sent Events.
// Every event is kept, so a browser opened (or reloaded) mid-run replays the story so far.
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

export interface Dashboard<E extends { type: string } = DashboardEvent> {
  url: string;
  emit(e: E): void;
  /** Events so far (for tests). */
  readonly history: (E & { seq: number })[];
  close(): Promise<void>;
}

const read = (file: string) => readFileSync(new URL(`../dashboard/${file}`, import.meta.url), "utf8");

/** `page` is a file in scripts/dashboard (default index.html, the main demo's page); `pnpm crowd` serves crowd.html. */
export async function startDashboard<E extends { type: string } = DashboardEvent>(o: { port: number; hostname?: string; page?: string }): Promise<Dashboard<E>> {
  const history: (E & { seq: number })[] = [];
  const listeners = new Set<(e: E & { seq: number }) => void>();
  const app = new Hono();
  app.get("/", (c) => c.html(read(o.page ?? "index.html")));
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
      for (const l of listeners) l(ev);
    },
    close: () => new Promise<void>((r) => { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); server.close(() => r()); }),
  };
}
