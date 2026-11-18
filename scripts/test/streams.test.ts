// QuickNode Streams source for the observer: the filter on real devnet blocks (fixtures saved from QuickNode's
// test_filter), the webhook receiver, and the watcher's Streams-first, RPC-fallback behaviour. No network access:
// QuickNode, the tunnel and the Solana RPC are faked.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { toObservation, type Observation } from "../lib/bot.js";
import { StreamWatcher, type SourceState, type StreamsConfig } from "../lib/streamWatcher.js";
import {
  filterSource, normalizeBatch, recordToObservation, runFilter, signBody, startReceiver, streamSpec,
  type Receiver, type StreamBatch, type Watch,
} from "../lib/streams.js";

const FEED = "GVaF8JseaBhMCKWWyTzdxW3Z3SDzSB3ZeX6AWK1WVECe";
const VAULT = "Bg9e9gBW5gDBqWCvV2o2YfcX4E5esER1uPrf7bj4DWuD";
const PROGRAM = "EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const watch: Watch = { tokenAccounts: [FEED, VAULT], vaultToken: VAULT, vaultProgram: PROGRAM, usdcMint: USDC };

type Block = { slot: number; blockTime: number; transactions: any[] };
const block = (slot: number): Block => JSON.parse(readFileSync(new URL(`./fixtures/block-${slot}.json`, import.meta.url), "utf8"))[0];
const PAYMENT = 522985052; // exact payment with memo whale-flow/SOL
const DEPOSIT = 522985117; // owner deposit into the vault (DepositMade #12)
const PAYOUT = 522985192; // vault settle_batch to the feed
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("observer-filter.js", () => {
  it("returns an exact payment as a compact record with sender, amount and memo", () => {
    const out = runFilter(watch, { data: [block(PAYMENT)] })!;
    expect(out.tip).toBe(PAYMENT);
    expect(out.deposits).toEqual([]);
    expect(out.records).toEqual([{
      signature: "KCWmTFeEAMfnzFfHUsYdknYHkvjrTtfjJuWrv4czSied2VvRHkVy6R4oicMdEWLBMgTisnN3Uiv97ZY8xLtRH4A", slot: PAYMENT, time: 1794850619,
      account: FEED, sender: "4pHmeiGjcswBjLjM2vjEK5Sf6JAGYciuL2G12KUDusqE", senderAccount: "8dHd7SyFCiTU8txx9nGXRr6P2xRVhpg8F5DL3Vt7Vkk3",
      recipient: "ELPmNrhcyY3tMYjZb9HuFRBiNSim4tcXjstm8E1F5bzd", amount: "50000", memo: "whale-flow/SOL",
    }]);
  });

  it("returns a vault deposit and decodes its DepositMade event", () => {
    const out = runFilter(watch, { data: [block(DEPOSIT)] })!;
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ account: VAULT, sender: "2DnMnsBJzzyHaecLX7Rmgz7E7muDDUQPs7cwTEdcxFru", amount: "1000000" });
    expect(out.records[0].memo).toBeUndefined();
    expect(out.deposits).toEqual([{
      signature: out.records[0].signature, slot: DEPOSIT, time: 1794850634, index: "12", depositor: "2DnMnsBJzzyHaecLX7Rmgz7E7muDDUQPs7cwTEdcxFru",
      amount: "1000000", depositRef: "b124cac662c52d75f8744023b98715ffd3649c2ff5de11ec62eb3c74381f5993",
    }]);
  });

  it("returns a vault payout with the vault as the sending account", () => {
    const out = runFilter(watch, { data: [block(PAYOUT)] })!;
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ account: FEED, senderAccount: VAULT, amount: "150000" });
  });

  it("drops unrelated and failed transactions but still reports the tip", () => {
    const b = block(PAYMENT);
    const unrelated = { ...b, transactions: b.transactions.slice(0, 2) };
    expect(runFilter(watch, { data: [unrelated] })).toEqual({ tip: PAYMENT, records: [], deposits: [] });
    const failed = structuredClone(b);
    for (const t of failed.transactions) t.meta.err = { InstructionError: [0, "Custom"] };
    expect(runFilter(watch, { data: [failed] })!.records).toEqual([]);
  });

  it("handles a batch of several blocks and ignores accounts it does not watch", () => {
    const out = runFilter(watch, { data: [block(PAYMENT), block(DEPOSIT), block(PAYOUT)] })!;
    expect(out.tip).toBe(PAYOUT);
    expect(out.records.map((r) => r.slot)).toEqual([PAYMENT, DEPOSIT, PAYOUT]);
    const vaultOnly = runFilter({ ...watch, tokenAccounts: [VAULT] }, { data: [block(PAYMENT), block(DEPOSIT), block(PAYOUT)] })!;
    expect(vaultOnly.records.map((r) => r.slot)).toEqual([DEPOSIT]);
  });

  it("describes each transaction exactly as an RPC poll does", () => {
    for (const slot of [PAYMENT, DEPOSIT, PAYOUT]) {
      const b = block(slot);
      const [rec] = runFilter(watch, { data: [b] })!.records;
      const tx = b.transactions.find((t) => t.transaction.signatures[0] === rec.signature);
      const viaRpc = toObservation(asParsed(tx), { signature: rec.signature, slot, blockTime: b.blockTime }, new PublicKey(rec.account), new PublicKey(USDC), new PublicKey(VAULT));
      expect(recordToObservation(rec, VAULT)).toEqual({ ...viaRpc, via: "streams" });
    }
  });

  it("uploads the checked-in filter with the addresses filled in", () => {
    const src = filterSource(watch);
    expect(src).toContain(`const WATCH = ${JSON.stringify(watch)}; // @watch`);
    const spec = streamSpec(watch, { url: "https://x.example/streams", token: "t".repeat(64), status: "paused" });
    expect(Buffer.from(spec.filter_function, "base64").toString()).toBe(src);
    expect(spec).toMatchObject({ network: "solana-devnet", dataset: "block", destination: "webhook", destination_attributes: { compression: "none" } });
  });
});

describe("normalizeBatch", () => {
  it("accepts the filter's object, arrays of them and a data wrapper", () => {
    const a: StreamBatch = { tip: 5, records: [], deposits: [] };
    expect(normalizeBatch(a)).toEqual(a);
    expect(normalizeBatch({ data: a })).toEqual(a);
    expect(normalizeBatch([a, { tip: 9, records: [], deposits: [] }])!.tip).toBe(9);
    expect(normalizeBatch({ hello: 1 })).toBeNull();
    expect(normalizeBatch(null)).toBeNull();
  });
});

describe("webhook receiver", () => {
  let receiver: Receiver | null = null;
  afterEach(async () => { await receiver?.close(); receiver = null; });

  const post = (port: number, body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/streams`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
  const signed = (token: string, body: string) => ({ "x-qn-nonce": "n1", "x-qn-timestamp": "1794850619", "x-qn-signature": signBody(token, "n1", "1794850619", body) });

  it("accepts signed deliveries and rejects bad signatures, bad JSON and other shapes", async () => {
    const got: StreamBatch[] = [];
    const token = "s".repeat(64);
    receiver = await startReceiver({ token, onBatch: (b) => got.push(b) });
    const body = JSON.stringify(runFilter(watch, { data: [block(PAYMENT)] }));
    expect((await post(receiver.port, body, signed(token, body))).status).toBe(200);
    expect(got).toHaveLength(1);
    expect(got[0].records[0].memo).toBe("whale-flow/SOL");
    expect((await post(receiver.port, body, signed("w".repeat(64), body))).status).toBe(401);
    expect((await post(receiver.port, body, {})).status).toBe(401);
    expect((await post(receiver.port, "{", signed(token, "{"))).status).toBe(400);
    expect((await post(receiver.port, "[1]", signed(token, "[1]"))).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${receiver.port}/health`)).status).toBe(200);
    expect(got).toHaveLength(1);
    expect(receiver.batches).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------- StreamWatcher

/** web3.js shape for a jsonParsed transaction: account keys as PublicKeys. */
function asParsed(tx: any): ParsedTransactionWithMeta {
  return { ...tx, transaction: { ...tx.transaction, message: { ...tx.transaction.message, accountKeys: tx.transaction.message.accountKeys.map((k: any) => ({ ...k, pubkey: new PublicKey(k.pubkey) })) } } };
}

/** A Solana RPC that knows the given blocks' transactions. Counts history calls to tell polling from Streams. */
function fakeRpc(blocks: Block[]) {
  const visible: Block[] = [];
  let slot = 522985000;
  const rpc = {
    calls: 0,
    show(b: Block) { visible.push(b); slot = Math.max(slot, b.slot); },
    getSlot: async () => slot,
    getSignaturesForAddress: async (a: PublicKey) => {
      rpc.calls++;
      return visible.flatMap((b) => b.transactions.filter((t) => t.transaction.message.accountKeys.some((k: any) => k.pubkey === a.toBase58()))
        .map((t) => ({ signature: t.transaction.signatures[0], slot: b.slot, blockTime: b.blockTime, err: null, memo: null }))).reverse();
    },
    getParsedTransaction: async (sig: string) => {
      const t = blocks.flatMap((b) => b.transactions).find((x) => x.transaction.signatures[0] === sig);
      return t ? asParsed(t) : null;
    },
  };
  return rpc;
}

/** QuickNode's API and the tunnel, faked. `deliver` posts a signed batch to whatever webhook the Stream points at. */
function fakeQuickNode(o: { createErrors?: string[] } = {}) {
  const errors = [...(o.createErrors ?? [])];
  const qn = {
    created: [] as ReturnType<typeof streamSpec>[],
    removed: [] as string[],
    paused: [] as string[],
    existing: { id: "old", name: "blindfold-observer", status: "paused", network: "solana-devnet" } as any,
    api: {
      find: async () => qn.existing,
      remove: async (id: string) => { qn.removed.push(id); qn.existing = null; return {}; },
      create: async (spec: ReturnType<typeof streamSpec>) => {
        const e = errors.shift();
        if (e) throw new Error(e);
        qn.created.push(spec);
        qn.existing = { id: `s${qn.created.length}`, name: spec.name, status: "active", network: spec.network, destination_attributes: { url: spec.destination_attributes.url } };
        return qn.existing;
      },
      get: async () => qn.existing,
      pause: async (id: string) => { qn.paused.push(id); return {}; },
    } satisfies StreamsConfig["api"],
    tunnel: async (port: number) => ({ url: `http://127.0.0.1:${port}`, close() {} }),
    async deliver(batch: StreamBatch) {
      const spec = qn.created.at(-1)!;
      const body = JSON.stringify(batch);
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await fetch(spec.destination_attributes.url, {
        method: "POST", body,
        headers: { "x-qn-nonce": "n", "x-qn-timestamp": ts, "x-qn-signature": signBody(spec.destination_attributes.security_token, "n", ts, body) },
      });
      expect(r.status).toBe(200);
    },
  };
  return qn;
}

describe("StreamWatcher", () => {
  let watcher: StreamWatcher | null = null;
  afterEach(async () => { await watcher?.stop(); watcher = null; });

  const blocks = [block(PAYMENT), block(DEPOSIT), block(PAYOUT)];
  const make = (rpc: ReturnType<typeof fakeRpc>, streams: StreamsConfig | null, extra: Partial<ConstructorParameters<typeof StreamWatcher>[0]> = {}) => {
    const seen: Observation[] = [];
    const states: SourceState[] = [];
    watcher = new StreamWatcher({
      connection: rpc as unknown as Connection, accounts: [new PublicKey(FEED), new PublicKey(VAULT)], usdcMint: new PublicKey(USDC),
      vaultToken: new PublicKey(VAULT), vaultProgram: new PublicKey(PROGRAM), intervalMs: 50, streams,
      onObservation: (ob) => seen.push(ob), onStatus: (s) => states.push(s), ...extra,
    });
    return { w: watcher, seen, states };
  };
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) { if (Date.now() > end) throw new Error("timed out"); await sleep(10); }
  };

  it("replaces the old Stream, then reads deliveries and stops polling", async () => {
    const rpc = fakeRpc(blocks);
    const qn = fakeQuickNode();
    const { w, seen, states } = make(rpc, { apiKey: "k", api: qn.api, tunnel: qn.tunnel });
    w.start();
    await until(() => qn.created.length === 1);
    expect(qn.removed).toEqual(["old"]);
    expect(qn.created[0]).toMatchObject({ status: "active", destination_attributes: { url: expect.stringMatching(/\/streams$/) } });
    expect(qn.created[0].destination_attributes.security_token).toHaveLength(64);
    await qn.deliver(runFilter(watch, { data: [block(PAYMENT)] })!);
    await until(() => w.state === "streams");
    expect(states).toEqual(["starting", "streams"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "direct_payment", memo: "whale-flow/SOL", via: "streams" });
    await sleep(150);
    const calls = rpc.calls;
    await qn.deliver(runFilter(watch, { data: [block(DEPOSIT), block(PAYOUT)] })!);
    await until(() => seen.length === 3);
    expect(seen.map((o) => o.kind)).toEqual(["direct_payment", "vault_deposit", "vault_payout"]);
    expect(w.deposits.map((d) => d.index)).toEqual(["12"]);
    await sleep(200);
    expect(rpc.calls).toBe(calls); // no polling while Streams delivers
  });

  it("reports a transaction once when both RPC and the Stream see it", async () => {
    const rpc = fakeRpc(blocks);
    rpc.show(block(PAYMENT));
    const qn = fakeQuickNode();
    const { w, seen } = make(rpc, { apiKey: "k", api: qn.api, tunnel: qn.tunnel });
    w.start();
    await until(() => seen.length === 1 && qn.created.length === 1);
    expect(seen[0].via).toBe("rpc");
    await qn.deliver(runFilter(watch, { data: [block(PAYMENT)] })!);
    await until(() => w.state === "streams");
    expect(seen).toHaveLength(1);
  });

  it("falls back to RPC polling when QuickNode refuses, and when deliveries stop", async () => {
    const rpc = fakeRpc(blocks);
    const refused = fakeQuickNode({ createErrors: ["QuickNode POST /streams: HTTP 403 plan limit"] });
    const a = make(rpc, { apiKey: "k", api: refused.api, tunnel: refused.tunnel });
    a.w.start();
    await until(() => a.states.includes("polling"));
    rpc.show(block(PAYMENT));
    await until(() => a.seen.length === 1);
    expect(a.seen[0].via).toBe("rpc");
    await a.w.stop();

    const rpc2 = fakeRpc(blocks);
    const qn = fakeQuickNode();
    const b = make(rpc2, { apiKey: "k", api: qn.api, tunnel: qn.tunnel }, { silenceMs: 150, healthMs: 30 });
    b.w.start();
    await until(() => qn.created.length === 1);
    await qn.deliver({ tip: PAYMENT - 1, records: [], deposits: [] });
    await until(() => b.w.state === "streams");
    await until(() => b.w.state === "fallback", 2000);
    rpc2.show(block(DEPOSIT));
    await until(() => b.seen.length === 1);
    expect(b.seen[0]).toMatchObject({ kind: "vault_deposit", via: "rpc" });
    // Deliveries resume: back to Streams.
    await qn.deliver(runFilter(watch, { data: [block(PAYOUT)] })!);
    await until(() => b.w.state === "streams");
    expect(b.states).toEqual(["starting", "streams", "fallback", "streams"]);
  });

  it("retries the create while QuickNode cannot resolve a new tunnel hostname", async () => {
    const qn = fakeQuickNode({ createErrors: ["HTTP 400 webhook URL is not allowed: URL hostname could not be resolved"] });
    const { w } = make(fakeRpc(blocks), { apiKey: "k", api: qn.api, tunnel: qn.tunnel, resolveRetryMs: 20 });
    w.start();
    await until(() => qn.created.length === 1);
    expect(w.state).toBe("starting");
  });

  it("waits for the Stream to pass the current slot in scan(), and pauses only its own Stream on stop", async () => {
    const rpc = fakeRpc(blocks);
    const qn = fakeQuickNode();
    const { w } = make(rpc, { apiKey: "k", api: qn.api, tunnel: qn.tunnel });
    w.start();
    await until(() => qn.created.length === 1);
    await qn.deliver({ tip: 522985000, records: [], deposits: [] });
    await until(() => w.state === "streams");
    rpc.show(block(PAYMENT)); // chain moves to slot PAYMENT
    const scanned = w.scan();
    await sleep(50);
    const calls = rpc.calls;
    await qn.deliver(runFilter(watch, { data: [block(PAYMENT)] })!);
    await scanned;
    expect(rpc.calls).toBe(calls);
    expect(w.observations).toHaveLength(1);
    await w.stop();
    expect(qn.paused).toEqual(["s1"]);

    // Taken over by another process: the Stream now points elsewhere, so stop() leaves it alone.
    const qn2 = fakeQuickNode();
    const two = make(fakeRpc(blocks), { apiKey: "k", api: qn2.api, tunnel: qn2.tunnel });
    two.w.start();
    await until(() => qn2.created.length === 1);
    qn2.existing.destination_attributes.url = "https://someone-else.example/streams";
    await two.w.stop();
    expect(qn2.paused).toEqual([]);
  });

  it("polls RPC only when Streams is not configured", async () => {
    const rpc = fakeRpc(blocks);
    rpc.show(block(PAYOUT));
    const { w, seen, states } = make(rpc, null);
    w.start();
    await until(() => seen.length === 1);
    expect(states).toEqual([]);
    expect(w.state).toBe("polling");
    expect(seen[0]).toMatchObject({ kind: "vault_payout", via: "rpc" });
  });
});
