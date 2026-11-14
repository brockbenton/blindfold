// In-process fake mint over HTTP (04-wallet-sdk.md, Source and tests), also serving redeem and reserves so e2e tests can reuse it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createBlindSignature, createDLEQProof, hashToCurve, pointFromHex, verifyMintQuoteSignature,
} from "@cashu/cashu-ts";
import { createTestKeyset, fakeRedeem, type TestKeyset } from "@blindfold/testkit";
import type { ProviderInfo, WireProof } from "@blindfold/protocol";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);

interface Quote {
  quote: string; request: string; amount: number; pubkey: string; paid: number; issued: number;
  signed: Map<string, unknown>; requests: Set<string>;
}

export interface FakeMintOptions {
  providers?: ProviderInfo[];
  keyset?: TestKeyset;
  reserves?: { issued: number; settled: number; outstanding: number };
}

export class FakeMint {
  readonly keyset: TestKeyset;
  providers: ProviderInfo[];
  reserves: { issued: number; settled: number; outstanding: number; keyset_id: string; updated_at: number };
  readonly quotes = new Map<string, Quote>();
  readonly manualSpent = new Set<string>();
  redeemer;
  /** Process the next mint request, then kill the connection without answering. */
  dropNextMintResponse = false;
  /** Corrupt the DLEQ of the first returned signature. */
  corruptDleq = false;
  mintRequests = 0;
  redeemCalls = 0;
  url = "";
  private server?: Server;

  constructor(o: FakeMintOptions = {}) {
    this.keyset = o.keyset ?? createTestKeyset(7);
    this.providers = o.providers ?? [];
    this.reserves = { issued: 0, settled: 0, outstanding: 0, ...o.reserves, keyset_id: this.keyset.id, updated_at: 0 };
    this.redeemer = fakeRedeem(this.keyset, this.activeProviderMap());
  }

  private activeProviderMap() {
    return new Map(this.providers.filter((p) => p.active).map((p) => [p.pubkey.toLowerCase(), p.provider_id]));
  }
  setProviders(ps: ProviderInfo[]) {
    this.providers = ps;
    const spent = this.redeemer.spent;
    this.redeemer = fakeRedeem(this.keyset, this.activeProviderMap());
    spent.forEach((y) => this.redeemer.spent.add(y));
  }

  markPaid(request: string, cents: number) {
    const q = [...this.quotes.values()].find((x) => x.request === request);
    if (!q) throw new Error("no quote for deposit_ref");
    q.paid += cents;
  }
  /** Mark a proof secret as spent (Y into the spent set). */
  spend(secret: string) {
    this.manualSpent.add(hashToCurve(utf8(secret)).toHex(true));
  }
  isSpent(secret: string) {
    const y = hashToCurve(utf8(secret)).toHex(true);
    return this.manualSpent.has(y) || this.redeemer.spent.has(y);
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => this.json(res, 500, { detail: String(e), code: 0 })));
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }
  async stop() {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }
  private err(res: ServerResponse, code: number, detail: string) {
    this.json(res, 400, { detail, code });
  }
  private quoteView(q: Quote) {
    return {
      quote: q.quote, request: q.request, unit: "usd", method: "solana-usdc", amount: q.amount,
      expiry: Math.floor(Date.now() / 1000) + 3600, pubkey: q.pubkey, amount_paid: q.paid, amount_issued: q.issued,
      updated_at: Math.floor(Date.now() / 1000), vault_program: "11111111111111111111111111111111",
      usdc_mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount_base_units: String(q.amount * 10_000),
    };
  }
  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString();
    return t ? JSON.parse(t) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const k = this.keyset;
    if (req.method === "GET") {
      if (p === "/v1/info") return this.json(res, 200, { name: "fake", nuts: {} });
      if (p === "/v1/keysets") return this.json(res, 200, { keysets: [{ id: k.id, unit: "usd", active: true, input_fee_ppk: 0 }] });
      if (p === "/v1/keys" || p === `/v1/keys/${k.id}`) return this.json(res, 200, { keysets: [{ id: k.id, unit: "usd", keys: k.keys }] });
      if (p === "/v1/blindfold/providers") return this.json(res, 200, this.providers);
      if (p === "/v1/blindfold/reserves") return this.json(res, 200, this.reserves);
      const m = /^\/v1\/mint\/quote\/solana-usdc\/(.+)$/.exec(p);
      if (m) {
        const q = this.quotes.get(m[1]);
        return q ? this.json(res, 200, this.quoteView(q)) : this.json(res, 404, { detail: "quote not found", code: 20001 });
      }
    } else if (req.method === "POST") {
      const b = await this.body(req);
      if (p === "/v1/mint/quote/solana-usdc") {
        if (b.unit !== "usd") return this.err(res, 11013, "unit");
        if (!(b.amount >= 1 && b.amount <= 5000)) return this.err(res, 11006, "amount");
        if (!b.pubkey) return this.err(res, 20009, "pubkey required");
        const q: Quote = {
          quote: crypto.randomUUID(), request: hex(crypto.getRandomValues(new Uint8Array(32))), amount: b.amount,
          pubkey: b.pubkey, paid: 0, issued: 0, signed: new Map(), requests: new Set(),
        };
        this.quotes.set(q.quote, q);
        return this.json(res, 200, this.quoteView(q));
      }
      if (p === "/v1/mint/solana-usdc") return this.mintTokens(b, res);
      if (p === "/v1/checkstate") {
        const spent = (y: string) => this.manualSpent.has(y) || this.redeemer.spent.has(y);
        return this.json(res, 200, { states: (b.Ys as string[]).map((Y) => ({ Y, state: spent(Y) ? "SPENT" : "UNSPENT", witness: null })) });
      }
      if (p === "/v1/blindfold/redeem") {
        this.redeemCalls++;
        const r = this.redeemer.redeem(b.proofs as WireProof[]);
        if (r.ok) return this.json(res, 200, { provider_id: r.provider_id, amount: r.amount, redemption_id: r.redemption_id });
        return this.err(res, r.code, r.detail);
      }
    }
    this.json(res, 404, { detail: "not found", code: 0 });
  }

  private mintTokens(b: any, res: ServerResponse) {
    this.mintRequests++;
    const q = this.quotes.get(b.quote);
    if (!q || q.paid <= 0) return this.err(res, 20001, "quote");
    const outs = b.outputs as { amount: number | string; id: string; B_: string }[];
    if (outs.length < 1 || outs.length > 256) return this.err(res, 11015, "outputs");
    const blinded = outs.map((o) => ({ ...o, amount: Number(o.amount) }));
    if (!b.signature || !verifyMintQuoteSignature(q.pubkey, q.quote, blinded as never, b.signature)) return this.err(res, 20008, "bad signature");
    const reqKey = outs.map((o) => o.B_).join();
    let sigs: unknown[];
    if (q.requests.has(reqKey)) {
      sigs = outs.map((o) => q.signed.get(o.B_));
    } else {
      if (outs.some((o) => q.signed.has(o.B_))) return this.err(res, 11003, "already signed");
      const total = blinded.reduce((s, o) => s + o.amount, 0);
      if (total > q.paid - q.issued) return this.err(res, 11006, "too much");
      sigs = blinded.map((o) => {
        const priv = this.keyset.privKeys[String(o.amount)];
        if (!priv || o.id !== this.keyset.id) throw new Error("bad amount or keyset");
        const B_ = pointFromHex(o.B_);
        const { C_ } = createBlindSignature(B_, priv, o.id);
        const d = createDLEQProof(B_, priv);
        const sig = { id: o.id, amount: o.amount, C_: C_.toHex(true), dleq: { s: hex(d.s), e: hex(d.e) } };
        q.signed.set(o.B_, sig);
        return sig;
      });
      q.issued += total;
      q.requests.add(reqKey);
    }
    if (this.corruptDleq) {
      const first = { ...(sigs[0] as any) };
      first.dleq = { ...first.dleq, e: "11".repeat(32) };
      sigs = [first, ...sigs.slice(1)];
    }
    if (this.dropNextMintResponse) {
      this.dropNextMintResponse = false;
      res.socket?.destroy();
      return;
    }
    this.json(res, 200, { signatures: sigs });
  }
}
