// Copycat's data source: QuickNode Streams first, RPC polling as the automatic fallback. Same surface as
// ChainWatcher (observations, start, stop, scan, waitFor, onObservation), so the demo, dashboard and inference do
// not care which source delivered a transaction.
//
// start() polls RPC while the tunnel and Stream come up. The first delivery switches to Streams-only and polling
// stops. If deliveries stop (the filter answers every batch, so silence means trouble), polling resumes until they
// come back. When Streams cannot start at all (no API key, no cloudflared, QuickNode refuses), Copycat simply keeps
// polling. Nothing in the demo depends on QuickNode being up.
import type { Connection, PublicKey } from "@solana/web3.js";
import { SOLANA_COMMITMENT } from "@blindfold/protocol";
import type { Observation } from "./bot.js";
import { ChainWatcher, type SlotRange } from "./copycat.js";
import {
  StreamsApi, newSecurityToken, recordToObservation, startReceiver, startTunnel, streamSpec,
  type Receiver, type StreamBatch, type StreamDeposit, type Tunnel, type Watch,
} from "./streams.js";

export type SourceState = "polling" | "starting" | "streams" | "fallback";

export interface StreamsConfig {
  apiKey: string;
  /** Use this public URL (forwarding to `port`) instead of starting a cloudflared quick tunnel. */
  webhookUrl?: string;
  port?: number;
  /** Swap in a fake QuickNode API or tunnel (tests). */
  api?: Pick<StreamsApi, "find" | "create" | "remove" | "pause" | "get">;
  tunnel?: (port: number) => Promise<Tunnel>;
  resolveTimeoutMs?: number;
  resolveRetryMs?: number;
}

export interface StreamWatcherOptions {
  connection: Connection;
  accounts: PublicKey[];
  usdcMint: PublicKey;
  vaultToken: PublicKey;
  vaultProgram: PublicKey;
  sinceSlot?: number;
  intervalMs?: number;
  /** Null: RPC polling only. */
  streams: StreamsConfig | null;
  /** Seconds without a delivery before polling takes over (default 20). */
  silenceMs?: number;
  /** How often to check for silence (default 5 s). */
  healthMs?: number;
  onObservation?: (ob: Observation) => void;
  onDeposit?: (d: StreamDeposit) => void;
  onStatus?: (state: SourceState, detail: string) => void;
  onError?: (e: unknown) => void;
}

export class StreamWatcher {
  private readonly rpc: ChainWatcher;
  private readonly watch: Watch;
  private receiver: Receiver | null = null;
  private tunnel: Tunnel | null = null;
  private streamId: string | null = null;
  private webhookUrl: string | null = null;
  private health: NodeJS.Timeout | null = null;
  private lastBatchAt = 0;
  private tipWaiters: (() => void)[] = [];
  private stopped = false;
  state: SourceState = "polling";
  /** Highest slot QuickNode has delivered (0 before the first delivery). */
  tip = 0;
  batches = 0;
  readonly deposits: StreamDeposit[] = [];

  constructor(private readonly o: StreamWatcherOptions) {
    this.rpc = new ChainWatcher({ ...o, onObservation: o.onObservation, onError: o.onError });
    this.watch = {
      tokenAccounts: o.accounts.map((a) => a.toBase58()), vaultToken: o.vaultToken.toBase58(), vaultProgram: o.vaultProgram.toBase58(),
      usdcMint: o.usdcMint.toBase58(),
    };
  }

  get observations(): Observation[] { return this.rpc.observations; }

  start(): this {
    this.rpc.start();
    if (this.o.streams) {
      this.setState("starting", "connecting QuickNode Streams; polling RPC meanwhile");
      this.connect(this.o.streams).catch((e) => {
        void this.disconnect();
        this.setState("polling", `QuickNode Streams unavailable, polling RPC: ${(e as Error).message}`);
      });
    }
    return this;
  }

  /** Handles one webhook delivery (also the receiver's callback). */
  ingest(batch: StreamBatch) {
    if (this.stopped) return;
    this.lastBatchAt = Date.now();
    this.batches++;
    this.tip = Math.max(this.tip, batch.tip);
    for (const r of batch.records) {
      if (this.o.sinceSlot !== undefined && r.slot < this.o.sinceSlot) continue;
      if (!this.watch.tokenAccounts.includes(r.account)) continue;
      this.rpc.ingest(r.account, recordToObservation(r, this.watch.vaultToken));
    }
    for (const d of batch.deposits) {
      if (this.deposits.some((x) => x.index === d.index)) continue;
      this.deposits.push(d);
      this.o.onDeposit?.(d);
    }
    for (const w of this.tipWaiters.splice(0)) w();
    if (this.state !== "streams") {
      const from = this.state;
      // One last poll covers anything that landed before the Stream's first block, then polling stops.
      void this.rpc.scan().catch((e) => this.o.onError?.(e)).finally(() => { if (this.state === "streams") this.rpc.stop(); });
      this.setState("streams", from === "fallback" ? "QuickNode Streams is delivering again; RPC polling stopped" : `reading QuickNode Streams (${this.webhookUrl})`);
    }
  }

  /**
   * Brings the view up to date. With a live Stream: waits until QuickNode has delivered the current slot (one RPC
   * call for the slot number), else falls back to one RPC poll.
   */
  async scan(): Promise<void> {
    if (this.state !== "streams") return this.rpc.scan();
    const slot = await this.o.connection.getSlot(SOLANA_COMMITMENT);
    if (await this.waitTip(slot, 15_000)) return;
    return this.rpc.scan();
  }

  /** One RPC pass whatever the source, so `coverage` reaches the current slot (Stream deliveries do not count there). */
  rpcScan(): Promise<void> { return this.rpc.scan(); }

  /** Slot ranges per watched account that RPC passes read completely (ChainWatcher.coverage). */
  coverage(): Record<string, SlotRange[]> { return this.rpc.coverage(); }

  /** Waits until `want` holds. Streams deliveries arrive by push; after 20 s without success it also polls RPC. */
  async waitFor(want: (obs: Observation[]) => boolean, timeoutMs = 60_000): Promise<Observation[]> {
    const start = Date.now();
    for (;;) {
      if (want(this.observations) || Date.now() - start > timeoutMs) return this.observations;
      if (this.state === "streams" && Date.now() - start < 20_000) await this.waitTip(this.tip + 1, 2000);
      else {
        await this.rpc.scan().catch((e) => this.o.onError?.(e));
        if (!want(this.observations)) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  async stop() {
    this.stopped = true;
    this.rpc.stop();
    await this.disconnect();
  }

  private setState(state: SourceState, detail: string) {
    this.state = state;
    this.o.onStatus?.(state, detail);
  }

  private waitTip(slot: number, timeoutMs: number): Promise<boolean> {
    if (this.tip >= slot) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.tipWaiters = this.tipWaiters.filter((w) => w !== check); resolve(this.tip >= slot); }, timeoutMs);
      const check = () => {
        if (this.tip >= slot) { clearTimeout(timer); resolve(true); } else this.tipWaiters.push(check);
      };
      this.tipWaiters.push(check);
    });
  }

  private async connect(cfg: StreamsConfig) {
    const token = newSecurityToken();
    this.receiver = await startReceiver({ token, onBatch: (b) => this.ingest(b), port: cfg.port });
    if (cfg.webhookUrl) this.webhookUrl = cfg.webhookUrl.replace(/\/$/, "");
    else {
      this.tunnel = await (cfg.tunnel ?? startTunnel)(this.receiver.port);
      this.webhookUrl = this.tunnel.url;
    }
    if (this.stopped) return this.disconnect();
    const url = `${this.webhookUrl}/streams`;
    const api = cfg.api ?? new StreamsApi(cfg.apiKey);
    // A fresh Stream each run: re-activating an old one resumes from its last delivered block, which after a pause
    // means replaying history before reaching the tip. The new one starts at the tip, with this run's tunnel URL,
    // security token and the filter for these addresses. (This also takes the Stream over from another process.)
    const existing = await api.find();
    if (existing) await api.remove(existing.id);
    const spec = streamSpec(this.watch, { url, token, status: "active" });
    // QuickNode resolves the webhook hostname on create. A new quick-tunnel name can take a while to resolve there
    // (and a too-early lookup is cached as missing for up to 60 s), so keep retrying that one error.
    for (let deadline = Date.now() + (cfg.resolveTimeoutMs ?? 90_000); ;) {
      try {
        this.streamId = (await api.create(spec)).id;
        break;
      } catch (e) {
        if (!/could not be resolved/i.test((e as Error).message) || Date.now() > deadline || this.stopped) throw e;
        await new Promise((r) => setTimeout(r, cfg.resolveRetryMs ?? 5000));
      }
    }
    if (this.stopped) return this.disconnect();
    this.lastBatchAt = Date.now();
    this.health = setInterval(() => this.checkHealth(), this.o.healthMs ?? 5000);
  }

  private checkHealth() {
    if (this.state !== "streams" && this.state !== "starting") return;
    const silent = Date.now() - this.lastBatchAt;
    if (silent < (this.o.silenceMs ?? 20_000)) return;
    if (this.state === "starting") this.setState("fallback", "QuickNode Streams sent nothing yet; polling RPC until it does");
    else this.setState("fallback", `no QuickNode delivery for ${Math.round(silent / 1000)} s; polling RPC until it resumes`);
    this.rpc.start();
  }

  /** Pauses the Stream only if it still points here: a later `pnpm bot` or demo may have taken it over. */
  private async disconnect() {
    if (this.health) clearInterval(this.health);
    this.health = null;
    const api = this.o.streams?.api ?? (this.o.streams ? new StreamsApi(this.o.streams.apiKey) : null);
    if (api && this.streamId && this.webhookUrl) {
      try {
        const s = await api.get(this.streamId);
        if (s.destination_attributes?.url === `${this.webhookUrl}/streams` && s.status === "active") await api.pause(this.streamId);
      } catch { /* best effort; a paused or deleted Stream is fine */ }
    }
    this.streamId = null;
    this.tunnel?.close();
    this.tunnel = null;
    await this.receiver?.close();
    this.receiver = null;
  }
}
