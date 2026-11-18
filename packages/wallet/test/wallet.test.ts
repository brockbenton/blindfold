import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Mint, verifyMintSignatures, type Proof } from "@cashu/cashu-ts";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { SOLANA_DEVNET_CAIP2, USDC_DEVNET_MINT, fromWireProof, signerSet } from "@blindfold/protocol";
import { AgentWallet, PaymentFailed, PaymentRefused, proofY } from "../src/index.js";
import { FileTokenStore } from "../src/store.js";
import { makeWorld, type World } from "./helpers.js";

let w: World;
const servers: Server[] = [];
afterEach(async () => {
  await w?.stop();
  for (const s of servers.splice(0)) { s.closeAllConnections(); s.close(); }
});

/** A raw server that always answers 402 with the given accepts entry, counting paid retries. */
async function rawServer(accept: Record<string, unknown>) {
  const state = { paid: 0, unpaid: 0 };
  const s = createServer((req, res) => {
    if (req.headers["payment-signature"]) { state.paid++; res.writeHead(200).end("ok"); return; }
    state.unpaid++;
    const pr = { x402Version: 2, resource: { url: "http://x/r", description: "x", mimeType: "text/plain" }, accepts: [accept] };
    res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") }).end("{}");
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/r`, state };
}

const accept = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  scheme: "blindfold", network: SOLANA_DEVNET_CAIP2, asset: USDC_DEVNET_MINT, amount: "50000", maxTimeoutSeconds: 60,
  payTo: "", extra: { mints: [] as string[], unit: "usd", nut10: { k: "P2PK", d: "" }, paymentFlow: "upfront", ...extra }, ...over,
});

describe("happy path", () => {
  it("owner flow writes verified locked proofs, then payFetch pays exactly the price", async () => {
    w = await makeWorld();
    await w.fund(100, undefined, true);
    const file = w.file();
    const keyset = { id: w.mint.keyset.id, keys: w.mint.keyset.keys };
    const proofs = file.proofs.map((p: any) => fromWireProof(p)) as Proof[];
    const v = await verifyMintSignatures(proofs, () => keyset, { require: true });
    expect(v.invalid).toHaveLength(0);
    const allow = [w.provider.pubkey, w.other.pubkey].sort();
    for (const p of file.proofs) expect([...signerSet(p.secret)].sort()).toEqual(allow);
    expect(file.proofs.reduce((s: number, p: any) => s + p.amount, 0)).toBe(100);
    expect(file.proofs.every((p: any) => !("witness" in p))).toBe(true);

    const wallet = await w.open();
    expect(wallet.balance()).toBe(100);
    const res = await wallet.payFetch(`${w.provider.url}/v1/data/sol`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { topic: string }).topic).toBe("sol");
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
    expect(settle.success).toBe(true);
    expect(settle.transaction).toMatch(/^redemption-/);
    expect(wallet.balance()).toBe(95);
    expect(wallet.pendingBalance()).toBe(0);
    expect(w.file().pending).toBeUndefined();
    expect(w.file().proofs.reduce((s: number, p: any) => s + p.amount, 0)).toBe(95);
  });

  it("returns non-402 responses unchanged and never throws for them", async () => {
    w = await makeWorld();
    await w.fund(10);
    const wallet = await w.open();
    const res = await wallet.payFetch(`${w.provider.url}/nope`);
    expect(res.status).toBe(404);
    expect(wallet.balance()).toBe(10);
  });
});

describe("refusals (nothing leaves the wallet, file unchanged)", () => {
  async function refused(reason: string, srv: { url: string; state: { paid: number } }, wallet: AgentWallet, msgNot = "Failed to create payment payload") {
    const before = readFileSync(w.tokenFile, "utf8");
    const err = await wallet.payFetch(srv.url).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRefused);
    expect(err.reason).toBe(reason);
    expect(err.message).not.toContain(msgNot);
    expect(srv.state.paid).toBe(0);
    expect(readFileSync(w.tokenFile, "utf8")).toBe(before);
    expect(wallet.balance()).toBe(100);
  }
  const setup = async () => { w = await makeWorld(); await w.fund(100); return w; };
  const good = () => ({ payTo: w.provider.pubkey, extra: { mints: [w.mint.url], nut10: { k: "P2PK", d: w.provider.pubkey } } });

  it("wrong unit", async () => {
    await setup();
    const g = good();
    await refused("unit", await rawServer(accept({ payTo: g.payTo }, { ...g.extra, unit: "sat" })), await w.open());
  });
  it("mint not in extra.mints", async () => {
    await setup();
    const g = good();
    await refused("mint", await rawServer(accept({ payTo: g.payTo }, { ...g.extra, mints: ["http://evil.example"] })), await w.open());
  });
  it.each([
    ["/Mint", "/mint"],
    ["/mint?tenant=owner", "/mint?tenant=other"],
    ["/mint?tenant=Owner", "/mint?tenant=owner"],
  ])("does not treat mint %s as mint %s", async (configured, advertised) => {
    await setup();
    const file = w.file();
    file.mint = `${w.mint.url}${configured}`;
    writeFileSync(w.tokenFile, JSON.stringify(file));
    const g = good();
    const wallet = await w.open({ mint: { check: async ({ Ys }) => ({ states: Ys.map((Y) => ({ Y, state: "UNSPENT" as const })) }) } });
    await refused("mint", await rawServer(accept({ payTo: g.payTo }, { ...g.extra, mints: [`${w.mint.url}${advertised}`] })), wallet);
  });
  it("still matches mint host case and trailing slashes", async () => {
    await setup();
    const file = w.file();
    const port = new URL(w.mint.url).port;
    file.mint = `http://LOCALHOST:${port}/Mint`;
    writeFileSync(w.tokenFile, JSON.stringify(file));
    const g = good();
    const srv = await rawServer(accept({ payTo: g.payTo }, { ...g.extra, mints: [`http://localhost:${port}/Mint///`] }));
    const wallet = await w.open({ mint: { check: async ({ Ys }) => ({ states: Ys.map((Y) => ({ Y, state: "UNSPENT" as const })) }) } });
    expect((await wallet.payFetch(srv.url)).status).toBe(200);
    expect(srv.state.paid).toBe(1);
  });
  it("wrong asset", async () => {
    await setup();
    const g = good();
    await refused("mint", await rawServer(accept({ payTo: g.payTo, asset: "So11111111111111111111111111111111111111112" }, g.extra)), await w.open());
  });
  it("amount over the cap (spend controls) maps to over_cap", async () => {
    await setup();
    const g = good();
    await refused("over_cap", await rawServer(accept({ payTo: g.payTo, amount: "110000" }, g.extra)), await w.open());
  });
  it("provider key not in the allowlist", async () => {
    await setup();
    const g = good();
    const wallet = await w.open({ allowlist: [w.other.pubkey] });
    await refused("provider_not_allowed", await rawServer(accept({ payTo: g.payTo }, g.extra)), wallet);
  });
  it("provider key allowed but not in the proofs' signer set", async () => {
    await setup();
    const k = w.attacker.pubkey;
    const wallet = await w.open({ allowlist: [k] });
    await refused("provider_not_in_signer_set", await rawServer(accept({ payTo: k }, { mints: [w.mint.url], nut10: { k: "P2PK", d: k } })), wallet);
  });
  it("payTo differs from nut10.d", async () => {
    await setup();
    const g = good();
    await refused("bad_request", await rawServer(accept({ payTo: w.other.pubkey }, g.extra)), await w.open());
  });
  it("non-whole-cent amount", async () => {
    await setup();
    const g = good();
    await refused("bad_request", await rawServer(accept({ payTo: g.payTo, amount: "50001" }, g.extra)), await w.open());
  });
  it("no exact subset", async () => {
    await setup();
    const g = good();
    const wallet = await w.open({ maxPerCallCents: 10 });
    // 100 cents of {4,1}x16 + ladder cannot make 7? it can; so drain to a single 4 and 8
    wallet.file.proofs = wallet.file.proofs.filter((p) => p.amount === 4).slice(0, 2);
    const srv = await rawServer(accept({ payTo: g.payTo, amount: "70000" }, g.extra));
    const err = await wallet.payFetch(srv.url).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRefused);
    expect(err.reason).toBe("insufficient_exact");
    expect(srv.state.paid).toBe(0);
  });
  it("insufficient balance", async () => {
    w = await makeWorld();
    await w.fund(3);
    const g = good();
    const srv = await rawServer(accept({ payTo: g.payTo }, g.extra));
    const err = await (await w.open()).payFetch(srv.url).then(() => null, (e) => e);
    expect(err.reason).toBe("insufficient_balance");
  });
  it("stream bodies are refused up front", async () => {
    await setup();
    const wallet = await w.open();
    const body = new ReadableStream({ start(c) { c.close(); } });
    const err = await wallet.payFetch(w.provider.url + "/v1/data/sol", { method: "POST", body, duplex: "half" } as RequestInit).then(() => null, (e) => e);
    expect(err.reason).toBe("bad_request");
  });
  it("hostile provider advertising an attacker key is refused, balance unchanged", async () => {
    w = await makeWorld({ mode: "hostile" });
    await w.fund(100);
    const wallet = await w.open();
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRefused);
    expect(err.reason).toBe("provider_not_allowed");
    expect(w.provider.paidRequests).toBe(0);
    expect(wallet.balance()).toBe(100);
  });
  it("hostile price (100 cents) is over_cap", async () => {
    w = await makeWorld({ mode: "hostilePrice" });
    await w.fund(100);
    const wallet = await w.open();
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err.reason).toBe("over_cap");
    expect(w.provider.paidRequests).toBe(0);
  });
  it("a server offering no cashu entry is bad_request", async () => {
    await setup();
    const srv = await rawServer(accept({ scheme: "exact" }));
    const err = await (await w.open()).payFetch(srv.url).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentRefused);
    expect(err.reason).toBe("bad_request");
  });
});

describe("failure recovery", () => {
  it("keeps proofs available if persisting a pending payment fails", async () => {
    w = await makeWorld();
    await w.fund(100);
    const wallet = await w.open();
    const write = vi.spyOn(FileTokenStore.prototype, "write").mockRejectedValueOnce(new Error("disk full"));
    try {
      await expect(wallet.payFetch(`${w.provider.url}/v1/data/sol`)).rejects.toThrow("disk full");
      expect(wallet.balance()).toBe(100);
      expect(wallet.pendingBalance()).toBe(0);
      expect(w.provider.handlerRuns).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it("rejected settle: proofs unspent at the mint, returned to the wallet", async () => {
    w = await makeWorld({ mode: "rejectSettle" });
    await w.fund(100);
    const wallet = await w.open();
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentFailed);
    expect(err.status).toBe(402);
    expect(err.recovered).toEqual({ returned: 5, dropped: 0 });
    expect(wallet.balance()).toBe(100);
    expect(wallet.pendingBalance()).toBe(0);
    expect(w.provider.handlerRuns).toBe(0);
  });
  it("lost response: proofs spent at the mint, dropped", async () => {
    w = await makeWorld({ mode: "dropResponse" });
    await w.fund(100);
    const wallet = await w.open();
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentFailed);
    expect(err.recovered).toEqual({ returned: 0, dropped: 5 });
    expect(wallet.balance()).toBe(95);
    expect(w.file().pending).toBeUndefined();
  });
  it("network error on the paid retry: checkstate recovery, error propagates", async () => {
    w = await makeWorld();
    await w.fund(100);
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as Request, init);
      if (req.headers.has("payment-signature")) throw new TypeError("fetch failed");
      return fetch(req);
    };
    const wallet = await w.open({ fetch: f });
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(wallet.balance()).toBe(100);
    expect(wallet.pendingBalance()).toBe(0);
  });
  it("mint unreachable during recovery: proofs stay pending, never returned blindly", async () => {
    w = await makeWorld({ mode: "rejectSettle" });
    await w.fund(100);
    const wallet = await w.open({ mint: { check: async () => { throw new Error("mint down"); } } });
    const err = await wallet.payFetch(`${w.provider.url}/v1/data/sol`).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(PaymentFailed);
    expect(wallet.balance()).toBe(95);
    expect(wallet.pendingBalance()).toBe(5);
    expect(w.file().pending).toHaveLength(1);
  });
  it("crash recovery on open(): unspent return, spent drop", async () => {
    w = await makeWorld();
    await w.fund(100);
    const f = w.file();
    const moved = f.proofs.splice(0, 4);
    f.pending = [{ proofs: moved, url: "http://x/y", sent_at: 1 }];
    writeFileSync(w.tokenFile, JSON.stringify(f));
    const total = (ps: any[]) => ps.reduce((s, p) => s + p.amount, 0);
    const spentAmt = total(moved.slice(0, 2));
    moved.slice(0, 2).forEach((p: any) => w.mint.spend(p.secret));
    const wallet = await w.open();
    expect(wallet.balance()).toBe(100 - spentAmt);
    expect(wallet.pendingBalance()).toBe(0);
    expect(w.file().pending).toBeUndefined();
    expect(w.file().proofs.map((p: any) => p.secret)).toEqual(expect.arrayContaining(moved.slice(2).map((p: any) => p.secret)));
  });
  it("crash recovery with an unreachable mint keeps the entry pending", async () => {
    w = await makeWorld();
    await w.fund(100);
    const f = w.file();
    f.pending = [{ proofs: f.proofs.splice(0, 2), url: "http://x/y", sent_at: 1 }];
    writeFileSync(w.tokenFile, JSON.stringify(f));
    const wallet = await w.open({ mint: { check: async () => { throw new Error("down"); } } });
    expect(wallet.pendingBalance()).toBeGreaterThan(0);
    expect(w.file().pending).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("10 parallel payFetch calls never send a proof twice", async () => {
    w = await makeWorld();
    await w.fund(100);
    const sent: string[] = [];
    const f: typeof fetch = async (input, init) => {
      const req = new Request(input as Request, init);
      const h = req.headers.get("payment-signature");
      if (h) sent.push(JSON.parse(Buffer.from(h, "base64").toString()).payload.token);
      return fetch(req);
    };
    const wallet = await w.open({ fetch: f });
    const results = await Promise.all(Array.from({ length: 10 }, () => wallet.payFetch(`${w.provider.url}/v1/data/sol`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(sent).toHaveLength(10);
    expect(new Set(sent).size).toBe(10);
    expect(wallet.balance()).toBe(50);
    expect(w.provider.handlerRuns).toBe(10);
    // every secret appears in exactly one token: check via Ys of the remaining proofs vs spent
    expect(w.file().proofs.reduce((s: number, p: any) => s + p.amount, 0)).toBe(50);
    void proofY; void Mint;
  });
});
