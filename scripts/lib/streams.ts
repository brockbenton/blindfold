// QuickNode Streams for the observer: the filter's configuration, the Streams REST API, a webhook receiver and a free
// cloudflared quick tunnel that makes the receiver reachable from QuickNode. scripts/lib/streamWatcher.ts combines
// them with RPC polling as the fallback.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { vaultAta } from "@blindfold/protocol";
import type { Observation, ObservationKind } from "./bot.js";

export const STREAM_NAME = "blindfold-observer";
export const STREAM_NETWORK = "solana-devnet";
export const STREAM_DATASET = "block";
const API = "https://api.quicknode.com/streams/rest/v1";
const FILTER_FILE = new URL("../streams/observer-filter.js", import.meta.url);

/** What the filter watches. `tokenAccounts` are USDC token accounts; incoming transfers to them become records. */
export interface Watch {
  tokenAccounts: string[];
  vaultToken: string;
  vaultProgram: string;
  usdcMint: string;
}

/** One USDC movement into a watched account, as the filter returns it. */
export interface StreamRecord {
  signature: string;
  slot: number;
  time: number | null;
  account: string;
  sender: string;
  senderAccount: string;
  recipient: string;
  amount: string;
  memo?: string;
}

/** A vault DepositMade event, decoded by the filter. */
export interface StreamDeposit {
  signature: string;
  slot: number;
  time: number | null;
  index: string;
  depositor: string;
  amount: string;
  depositRef: string;
}

/** What one webhook delivery carries: the newest slot in the batch and what matched in it. */
export interface StreamBatch {
  tip: number;
  records: StreamRecord[];
  deposits: StreamDeposit[];
}

/** The demo feeds' payout wallets in `keysDir`: TokenFeed (required) and NewsWire (once `pnpm demo` has created it). */
export function feedWallets(keysDir: string): { name: string; owner: PublicKey }[] {
  const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keysDir, f), "utf8")) as number[])).publicKey;
  return [["TokenFeed", "provider-payout.json"], ["NewsWire", "news-payout.json"]]
    .filter(([, f]) => existsSync(join(keysDir, f)))
    .map(([name, f]) => ({ name, owner: load(f) }));
}

/**
 * What `pnpm bot` watches: `account` if given, else every demo feed's payout account (from .keys/), plus the vault.
 * The first token account is the main feed's.
 */
export function defaultWatch(o: { keysDir: string; usdcMint: PublicKey; programId: PublicKey; account?: PublicKey }): Watch {
  let accounts = o.account ? [o.account] : [];
  if (!o.account) {
    const feeds = feedWallets(o.keysDir);
    if (!feeds.some((f) => f.name === "TokenFeed")) throw new Error(`pass --account <token account>, or restore ${join(o.keysDir, "provider-payout.json")}`);
    accounts = feeds.map((f) => getAssociatedTokenAddressSync(o.usdcMint, f.owner));
  }
  const vaultToken = vaultAta(o.usdcMint, o.programId).toBase58();
  return { tokenAccounts: [...accounts.map((a) => a.toBase58()), vaultToken], vaultToken, vaultProgram: o.programId.toBase58(), usdcMint: o.usdcMint.toBase58() };
}

/** The filter's JavaScript with `watch` filled in: exactly what is uploaded to QuickNode. */
export function filterSource(watch: Watch): string {
  const src = readFileSync(FILTER_FILE, "utf8");
  const line = /^const WATCH = .*\/\/ @watch$/m;
  if (!line.test(src)) throw new Error("observer-filter.js lost its `const WATCH = ...; // @watch` line");
  return src.replace(line, `const WATCH = ${JSON.stringify(watch)}; // @watch`);
}

/** Runs the filter locally on a Streams payload, as QuickNode would (tests, and `streams-setup --local`). */
export function runFilter(watch: Watch, stream: { data: unknown; metadata?: unknown }): StreamBatch | null {
  const sandbox: { stream: unknown; result?: unknown } = { stream };
  runInNewContext(`${filterSource(watch)}\nresult = main(stream);`, sandbox, { timeout: 2000 });
  return sandbox.result as StreamBatch | null;
}

/** A webhook body as a batch. Accepts the filter's object, an array of them, or one wrapped in `data`. */
export function normalizeBatch(body: unknown): StreamBatch | null {
  if (Array.isArray(body)) {
    const parts = body.map(normalizeBatch).filter((b): b is StreamBatch => b !== null);
    if (!parts.length) return null;
    return { tip: Math.max(...parts.map((p) => p.tip)), records: parts.flatMap((p) => p.records), deposits: parts.flatMap((p) => p.deposits) };
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<StreamBatch> & { data?: unknown };
  if (typeof b.tip === "number") return { tip: b.tip, records: b.records ?? [], deposits: b.deposits ?? [] };
  return b.data !== undefined ? normalizeBatch(b.data) : null;
}

/** The same Observation an RPC poll would produce for this transaction (see toObservation in bot.ts). */
export function recordToObservation(r: StreamRecord, vaultToken: string): Observation {
  const kind: ObservationKind = r.account === vaultToken ? "vault_deposit" : r.senderAccount === vaultToken ? "vault_payout" : "direct_payment";
  return {
    kind, signature: r.signature, slot: r.slot, time: r.time ? new Date(r.time * 1000) : null, from: r.sender, to: r.recipient,
    amountBase: BigInt(r.amount), ...(r.memo !== undefined ? { memo: r.memo } : {}), via: "streams",
  };
}

/** QuickNode signs each delivery: hex HMAC-SHA256 over nonce + timestamp + body, keyed with the security token. */
export function verifySignature(token: string, headers: IncomingHttpHeaders, body: string): boolean {
  const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
  const nonce = h("x-qn-nonce");
  const ts = h("x-qn-timestamp");
  const sig = h("x-qn-signature");
  if (!nonce || !ts || !sig) return false;
  const want = createHmac("sha256", token).update(nonce + ts + body).digest();
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export const signBody = (token: string, nonce: string, ts: string, body: string) => createHmac("sha256", token).update(nonce + ts + body).digest("hex");

// ------------------------------------------------------------------------------------------------- REST API

export interface StreamInfo { id: string; name: string; status: string; network: string; destination_attributes?: { url?: string } }

/** The Stream's full configuration. Free-plan friendly: webhook, no compression, no reorg handling, follows the tip. */
export function streamSpec(watch: Watch, o: { url: string; token: string; status: "active" | "paused" }) {
  return {
    name: STREAM_NAME,
    network: STREAM_NETWORK,
    dataset: STREAM_DATASET,
    region: "usa_east",
    filter_function: Buffer.from(filterSource(watch)).toString("base64"),
    dataset_batch_size: 5,
    elastic_batch_enabled: true,
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    destination: "webhook",
    destination_attributes: { url: o.url, compression: "none", max_retry: 5, retry_interval_sec: 2, post_timeout_sec: 10, security_token: o.token },
    status: o.status,
  };
}

export class StreamsApi {
  constructor(private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly base = API) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method, headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`QuickNode ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async list(): Promise<StreamInfo[]> {
    const r = await this.call<StreamInfo[] | { data: StreamInfo[] }>("GET", "/streams?limit=100");
    return Array.isArray(r) ? r : r.data ?? [];
  }
  async find(name = STREAM_NAME) { return (await this.list()).find((s) => s.name === name) ?? null; }
  get(id: string) { return this.call<StreamInfo>("GET", `/streams/${id}`); }
  create(spec: ReturnType<typeof streamSpec>) { return this.call<StreamInfo>("POST", "/streams", spec); }
  update(id: string, patch: Partial<ReturnType<typeof streamSpec>>) { return this.call<StreamInfo>("PATCH", `/streams/${id}`, patch); }
  pause(id: string) { return this.call<unknown>("POST", `/streams/${id}/pause`); }
  activate(id: string) { return this.call<unknown>("POST", `/streams/${id}/activate`); }
  remove(id: string) { return this.call<unknown>("DELETE", `/streams/${id}`); }
  async testFilter(watch: Watch, slot: number): Promise<{ logs: unknown[]; result: unknown }> {
    const r = await this.call<{ logs: unknown[]; result: unknown }>("POST", "/streams/test_filter", {
      network: STREAM_NETWORK, dataset: STREAM_DATASET, filter_function: Buffer.from(filterSource(watch)).toString("base64"), block: String(slot),
    });
    return { logs: r.logs, result: typeof r.result === "string" ? JSON.parse(r.result) : r.result };
  }
}

/** `.keys/quicknode.json` ({ "apiKey": "..." }), or QUICKNODE_API_KEY. Null when neither is set. */
export function loadApiKey(keysDir: string): string | null {
  if (process.env.QUICKNODE_API_KEY) return process.env.QUICKNODE_API_KEY;
  const p = join(keysDir, "quicknode.json");
  if (!existsSync(p)) return null;
  const k = (JSON.parse(readFileSync(p, "utf8")) as { apiKey?: string }).apiKey;
  return k || null;
}

// --------------------------------------------------------------------------------------- webhook receiver

export interface Receiver {
  port: number;
  readonly batches: number;
  close(): Promise<void>;
}

/**
 * Serves POST /streams for QuickNode deliveries (signature checked when `token` is set) and GET /health for the
 * tunnel check. Each valid batch goes to `onBatch`; the response is 200 as soon as the body is parsed.
 */
export async function startReceiver(o: { token: string | null; onBatch: (b: StreamBatch) => void; port?: number; hostname?: string }): Promise<Receiver> {
  let batches = 0;
  const server = createServer((req, res) => {
    const reply = (code: number, text = "") => { res.writeHead(code, { "content-type": "text/plain" }); res.end(text); };
    if (req.method === "GET" && req.url === "/health") return reply(200, "ok");
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/streams") return reply(404);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 5_000_000) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (o.token && !verifySignature(o.token, req.headers, body)) return reply(401, "bad signature");
      let batch: StreamBatch | null;
      try { batch = normalizeBatch(JSON.parse(body)); } catch { return reply(400, "bad json"); }
      if (!batch) return reply(400, "not an observer batch");
      batches++;
      reply(200, "ok");
      o.onBatch(batch);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(o.port ?? 0, o.hostname ?? "127.0.0.1", () => resolve()); });
  return {
    port: (server.address() as { port: number }).port,
    get batches() { return batches; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// ------------------------------------------------------------------------------------------------- tunnel

export interface Tunnel { url: string; close(): void }

/** cloudflared from PATH or ~/.local/bin, or CLOUDFLARED. */
export function cloudflaredBin(): string | null {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  for (const dir of (process.env.PATH ?? "").split(":").concat(join(homedir(), ".local/bin"))) {
    if (dir && existsSync(join(dir, "cloudflared"))) return join(dir, "cloudflared");
  }
  return null;
}

/**
 * A Cloudflare quick tunnel (no account) to localhost:`port`. Resolves once cloudflared has registered a connection.
 * No local probe: looking up a brand-new hostname too early caches it as missing for 60 s on whichever resolver
 * answered. QuickNode checks the hostname itself on create (retried in streamWatcher.ts), and missing deliveries
 * trigger the RPC fallback.
 */
export async function startTunnel(port: number, timeoutMs = 30_000): Promise<Tunnel> {
  const bin = cloudflaredBin();
  if (!bin) throw new Error("cloudflared not found (install it, or set STREAMS_WEBHOOK_URL to your own tunnel)");
  const child: ChildProcess = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  const close = () => { if (child.exitCode === null) child.kill("SIGTERM"); };
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let found: string | null = null;
      let log = "";
      const timer = setTimeout(() => reject(new Error(found ? "cloudflared did not register a connection" : "cloudflared did not print a tunnel URL")), timeoutMs);
      const scan = (d: Buffer) => {
        log = (log + d.toString()).slice(-20_000);
        found ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0] ?? null;
        if (found && /Registered tunnel connection/.test(log)) { clearTimeout(timer); resolve(found); }
      };
      child.stdout!.on("data", scan);
      child.stderr!.on("data", scan);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited (${code})`)); });
    });
    await new Promise((r) => setTimeout(r, 3000));
    return { url, close };
  } catch (e) {
    close();
    throw e;
  }
}

export const newSecurityToken = () => randomBytes(32).toString("hex");
