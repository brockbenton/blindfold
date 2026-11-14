// Throwaway feasibility spike: Blindfold as a custom x402 v2 scheme ("cashu").
// Real x402 server middleware (@x402/hono) + real client (@x402/fetch) + real cashu-ts crypto.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import {
  createNewMintKeys, createBlindSignature, createDLEQProof, pointFromHex, hashToCurve,
  verifyUnblindedSignature, OutputData, signP2PKProofs, getPubKeyFromPrivKey, createRandomSecretKey,
  getEncodedToken, getDecodedToken, parseP2PKSecret, getValidSigners, getP2PKWitnessSignatures,
  type Proof,
} from "@cashu/cashu-ts";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MINT_URL = "http://localhost:3338";
const BASE_PER_CENT = 10_000n;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const utf8 = (s: string) => new TextEncoder().encode(s);
const log = (...a: unknown[]) => console.log("  ", ...a);
let failures = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(ok ? "PASS" : "FAIL", name, extra); if (!ok) failures++; };

// ---------------- Mint (in-process stand-in for services/mint) ----------------
const kp = createNewMintKeys(13, new Uint8Array(32).fill(7), { unit: "usd" });
const keyset = { id: kp.keysetId, keys: Object.fromEntries(Object.entries(kp.pubKeys).map(([a, k]) => [a, hex(k)])) };
const spent = new Set<string>();
let lastPaymentHeader: string | null = null;
const providers = new Map<string, number>(); // cashu pubkey hex -> provider_id
const balances = new Map<number, number>();

function mintSign(outputs: OutputData[]): Proof[] {
  return outputs.map((od) => {
    const bm = od.blindedMessage;
    const amt = String(bm.amount);
    const B_ = pointFromHex(bm.B_);
    const { C_ } = createBlindSignature(B_, kp.privKeys[amt], bm.id);
    const dleq = createDLEQProof(B_, kp.privKeys[amt]);
    return od.toProof({ id: bm.id, amount: bm.amount, C_: C_.toHex(true), dleq: { s: hex(dleq.s), e: hex(dleq.e) } } as any, keyset);
  });
}

function signerSet(secret: string): string[] {
  const s = parseP2PKSecret(secret) as any;
  const [kind, data] = Array.isArray(s) ? s : [s.kind ?? "P2PK", s];
  if (kind !== "P2PK") throw new Error("not P2PK");
  const tags: string[][] = data.tags ?? [];
  const pk = tags.find((t) => t[0] === "pubkeys")?.slice(1) ?? [];
  return [data.data, ...pk];
}

type RedeemResult = { ok: true; provider_id: number; amount: number; redemption_id: string } | { ok: false; code: number; detail: string };
function redeem(proofs: Proof[]): RedeemResult {
  let signer: string | undefined;
  const Ys: string[] = [];
  for (const p of proofs) {
    const amt = String(p.amount);
    if (p.id !== keyset.id || !kp.privKeys[amt]) return { ok: false, code: 12001, detail: "unknown keyset/amount" };
    if (!verifyUnblindedSignature({ C: pointFromHex(p.C), secret: utf8(p.secret), id: p.id }, kp.privKeys[amt]))
      return { ok: false, code: 10001, detail: "bad C" };
    let set: string[];
    try { set = signerSet(p.secret); } catch { return { ok: false, code: 70001, detail: "not P2PK" }; }
    const sigs = p.witness ? getP2PKWitnessSignatures(p.witness as any) : [];
    const valid = getValidSigners(sigs, p.secret, set);
    if (valid.length !== 1) return { ok: false, code: 10001, detail: `valid signers=${valid.length}` };
    if (!providers.has(valid[0])) return { ok: false, code: 70002, detail: "signer not registered" };
    if (signer && signer !== valid[0]) return { ok: false, code: 70003, detail: "mixed signers" };
    signer = valid[0];
    Ys.push(hashToCurve(utf8(p.secret)).toHex(true));
  }
  // "one DB transaction"
  if (Ys.some((y) => spent.has(y))) return { ok: false, code: 11001, detail: "already spent" };
  Ys.forEach((y) => spent.add(y));
  const pid = providers.get(signer!)!;
  const amount = proofs.reduce((s, p) => s + Number(p.amount), 0);
  balances.set(pid, (balances.get(pid) ?? 0) + amount);
  return { ok: true, provider_id: pid, amount, redemption_id: crypto.randomUUID() };
}

// ---------------- Provider (mock API) ----------------
const providerSk = createRandomSecretKey();
const providerPk = hex(getPubKeyFromPrivKey(providerSk));
const otherSk = createRandomSecretKey();
const otherPk = hex(getPubKeyFromPrivKey(otherSk)); // second allowlisted provider
const evilPk = hex(getPubKeyFromPrivKey(createRandomSecretKey())); // never registered
providers.set(providerPk, 0);
providers.set(otherPk, 1);
const PRICE_CENTS = 5;

// x402 facilitator role, implemented by "the mint". The provider signs proofs, then the mint redeems.
let settleCalls = 0, verifyCalls = 0; let lastSettleError = "";
const facilitator = {
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "cashu", network: NET }], extensions: [], signers: {} };
  },
  async verify(payload: any, req: any) {
    verifyCalls++;
    return { isValid: true };
  },
  async settle(payload: any, req: any) {
    settleCalls++;
    try {
      const token = getDecodedToken(payload.payload.token, [keyset.id]);
      const wantCents = Number(BigInt(req.amount) / BASE_PER_CENT);
      const sum = token.proofs.reduce((s, p) => s + Number(p.amount), 0);
      if (token.mint !== MINT_URL) return { success: false, errorReason: "wrong_mint", transaction: "", network: NET };
      if (sum !== wantCents) return { success: false, errorReason: "wrong_amount", transaction: "", network: NET };
      if (!token.proofs.every((p) => signerSet(p.secret).includes(providerPk)))
        { lastSettleError = "wrong_lock"; return { success: false, errorReason: "wrong_lock", transaction: "", network: NET }; }
      const signed = signP2PKProofs(token.proofs, hex(providerSk));
      const r = redeem(signed);
      if (!r.ok) lastSettleError = `redeem_failed_${r.code}`;
      if (!r.ok) return { success: false, errorReason: `redeem_failed_${r.code}`, errorMessage: r.detail, transaction: "", network: NET };
      return { success: true, transaction: r.redemption_id, network: NET, amount: req.amount };
    } catch (e: any) {
      return { success: false, errorReason: "malformed_token", errorMessage: String(e?.message ?? e), transaction: "", network: NET };
    }
  },
};

const cashuServerScheme = {
  scheme: "cashu",
  defaultAssetTransferMethod: "default",
  paymentFlows: { default: { supported: ["upfront"], default: "upfront" } },
  async parsePrice(price: any, network: string) {
    if (typeof price === "object" && price && "amount" in price) return price;
    throw new Error("use AssetAmount");
  },
  async enhancePaymentRequirements(req: any) {
    return { ...req, extra: { ...req.extra, mints: [MINT_URL], unit: "usd", nut10: { k: "P2PK", d: providerPk } } };
  },
};

// A second, unrelated scheme on the same route, to prove a client picks the one it supports.
const dummyServerScheme = { ...cashuServerScheme, scheme: "dummy", async enhancePaymentRequirements(r: any) { return r; } };
const dummyFacilitator = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: "dummy", network: NET }], extensions: [], signers: {} }; },
  async verify() { return { isValid: false, invalidReason: "dummy" }; },
  async settle() { return { success: false, errorReason: "dummy", transaction: "", network: NET }; },
};

const resourceServer = new x402ResourceServer([facilitator as any, dummyFacilitator as any])
  .register(NET, cashuServerScheme as any)
  .register(NET, dummyServerScheme as any);

let handlerRuns = 0;
const app = new Hono();
app.use(async (c, next) => { const h = c.req.header("PAYMENT-SIGNATURE"); if (h) lastPaymentHeader = h; await next(); });
app.use(paymentMiddleware({
  "GET /v1/data/:topic": {
    accepts: [
      { scheme: "dummy", price: { amount: "50000", asset: USDC }, network: NET, payTo: "dummy" },
      { scheme: "cashu", price: { amount: String(BigInt(PRICE_CENTS) * BASE_PER_CENT), asset: USDC }, network: NET, payTo: providerPk },
    ],
    description: "market data",
  },
} as any, resourceServer));
app.get("/v1/data/:topic", (c) => { handlerRuns++; return c.json({ topic: c.req.param("topic"), price: 172.4 }); });
const server = serve({ fetch: app.fetch, port: 4011 });

// ---------------- Owner: issue locked tokens (global allowlist, 1-of-N) ----------------
const allowlist = [providerPk, otherPk].sort();
const lock = { pubkey: allowlist, requiredSignatures: 1, sigFlag: "SIG_INPUTS" as const };
let walletProofs: Proof[] = mintSign(OutputData.createP2PKData(lock as any, 20, keyset, [4, 1, 4, 1, 8, 2]));
// Tokens locked to someone NOT the provider (to test client-side refusal / server wrong_lock)
const foreignProofs: Proof[] = mintSign(OutputData.createP2PKData({ pubkey: otherPk } as any, 5, keyset, [4, 1]));

// ---------------- Agent wallet: x402 client scheme ----------------
const MAX_PER_CALL = 10;
function selectExact(proofs: Proof[], cents: number, pk: string): Proof[] | null {
  const elig = proofs.filter((p) => signerSet(p.secret).includes(pk));
  const n = elig.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    let s = 0; const pick: Proof[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += elig[i].amount.toNumber(); pick.push(elig[i]); }
    if (s === cents) return pick;
  }
  return null;
}
let refusal: string | null = null;
const cashuClientScheme = {
  scheme: "cashu",
  async createPaymentPayload(x402Version: number, req: any) {
    const cents = Number(BigInt(req.amount) / BASE_PER_CENT);
    const pk = req.extra?.nut10?.d;
    const refuse = (r: string) => { refusal = r; throw new Error(`PaymentRefused:${r}`); };
    if (req.asset !== USDC) refuse("asset");
    if (!req.extra?.mints?.includes(MINT_URL)) refuse("mint");
    if (cents > MAX_PER_CALL) refuse("over_cap");
    if (!allowlist.includes(pk)) refuse("provider_not_allowed");
    const chosen = selectExact(walletProofs, cents, pk) ?? refuse("insufficient_exact");
    walletProofs = walletProofs.filter((p) => !chosen!.includes(p)); // (real SDK: mark pending)
    const token = getEncodedToken({ mint: MINT_URL, unit: "usd", proofs: chosen! });
    return { x402Version, payload: { token } };
  },
};
const client = new x402Client().register(NET, cashuClientScheme as any)
  .setSpendControls({ allowedAssets: [{ network: NET, asset: USDC, maxAmountPerPayment: String(BigInt(MAX_PER_CALL) * BASE_PER_CENT) }] });
const spyFetch: typeof fetch = async (input, init) => {
  const h = new Headers((init as any)?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (h.get("PAYMENT-SIGNATURE")) lastPaymentHeader = h.get("PAYMENT-SIGNATURE");
  return fetch(input, init);
};
const payFetch = wrapFetchWithPayment(spyFetch, client);
const bal = () => walletProofs.reduce((s, p) => s + Number(p.amount), 0);

// ---------------- Tests ----------------
try {
  await new Promise((r) => setTimeout(r, 200));
  const url = "http://localhost:4011/v1/data/sol";

  // 0. Raw 402 shape
  const raw = await fetch(url);
  const pr = raw.headers.get("PAYMENT-REQUIRED");
  const decoded = pr ? JSON.parse(Buffer.from(pr, "base64").toString()) : null;
  check("402 with PAYMENT-REQUIRED header", raw.status === 402 && !!decoded);
  log("accepts:", JSON.stringify(decoded?.accepts));

  // 1. Paid call
  const before = bal();
  const r1 = await payFetch(url);
  const body1 = await r1.json().catch(() => null);
  const pres = r1.headers.get("PAYMENT-RESPONSE");
  const settle1 = pres ? decodePaymentResponseHeader(pres) : null;
  check("paid call returns 200 + data", r1.status === 200 && body1?.topic === "sol", `status=${r1.status}`);
  check("wallet balance dropped by exact price", before - bal() === PRICE_CENTS, `${before} -> ${bal()}`);
  check("PAYMENT-RESPONSE carries redemption id", !!settle1?.success && !!settle1?.transaction, JSON.stringify(settle1));
  check("provider credited at mint", balances.get(0) === PRICE_CENTS, JSON.stringify([...balances]));
  log(`verify calls=${verifyCalls} settle calls=${settleCalls} handler runs=${handlerRuns} (upfront: settle before handler)`);

  // 2. Replay the exact same PAYMENT-SIGNATURE header
  const runsBefore = handlerRuns; lastSettleError = "";
  const r2 = await fetch(url, { headers: { "PAYMENT-SIGNATURE": lastPaymentHeader! } });
  const r2body = await r2.text();
  check("replay rejected by mint spent set (11001), handler not run", r2.status !== 200 && handlerRuns === runsBefore && lastSettleError === "redeem_failed_11001", `settleErr=${lastSettleError}`);
  log("replay",  `status=${r2.status} body=${r2body.slice(0, 160)}`);

  // 3. Wrong lock: send tokens locked only to the OTHER provider, built by hand
  const tokForeign = getEncodedToken({ mint: MINT_URL, unit: "usd", proofs: foreignProofs });
  const accepted = decoded.accepts.find((a: any) => a.scheme === "cashu");
  const forged = Buffer.from(JSON.stringify({ x402Version: 2, resource: decoded.resource, accepted, payload: { token: tokForeign } })).toString("base64");
  lastSettleError = "";
  const r3 = await fetch(url, { headers: { "PAYMENT-SIGNATURE": forged } });
  check("token not locked to this provider rejected (wrong_lock)", r3.status !== 200 && lastSettleError === "wrong_lock", `status=${r3.status} settleErr=${lastSettleError}`);

  // 4. Prompt injection: evil provider, client refuses before anything leaves the wallet
  const evilApp = new Hono();
  const evilRS = new x402ResourceServer([facilitator as any]).register(NET, { ...cashuServerScheme, async enhancePaymentRequirements(r: any) { return { ...r, extra: { mints: [MINT_URL], unit: "usd", nut10: { k: "P2PK", d: evilPk } } }; } } as any);
  evilApp.use(paymentMiddleware({ "GET /steal": { accepts: [{ scheme: "cashu", price: { amount: "50000", asset: USDC }, network: NET, payTo: evilPk }], description: "x" } } as any, evilRS));
  evilApp.get("/steal", (c) => c.text("gotcha"));
  const evilServer = serve({ fetch: evilApp.fetch, port: 4012 });
  await new Promise((r) => setTimeout(r, 100));
  const balBefore = bal(); refusal = null;
  let threw = false;
  try { const r4 = await payFetch("http://localhost:4012/steal"); log("evil status", r4.status); } catch (e: any) { threw = true; log("evil:", String(e.message).slice(0, 120)); }
  check("evil provider refused client-side, no proofs spent", threw && refusal === "provider_not_allowed" && bal() === balBefore, `refusal=${refusal}`);
  evilServer.close();

  // 5. Over cap
  const capApp = new Hono();
  capApp.use(paymentMiddleware({ "GET /pricey": { accepts: [{ scheme: "cashu", price: { amount: String(50n * BASE_PER_CENT), asset: USDC }, network: NET, payTo: providerPk }], description: "x" } } as any, resourceServer));
  capApp.get("/pricey", (c) => c.text("x"));
  const capServer = serve({ fetch: capApp.fetch, port: 4013 });
  await new Promise((r) => setTimeout(r, 100));
  refusal = null; let capErr = "";
  const balCap = bal();
  try { await payFetch("http://localhost:4013/pricey"); } catch (e: any) { capErr = String(e.message); }
  check("over per-call cap refused (x402 spendControls before our scheme)", !!capErr && bal() === balCap, capErr.slice(0, 140));
  capServer.close();

  // 6. Second paid call still works (exact selection from remaining coins)
  const r6 = await payFetch("http://localhost:4011/v1/data/btc");
  check("second paid call", r6.status === 200, `status=${r6.status} balance=${bal()}`);
} catch (e) {
  console.error("SPIKE CRASH", e); failures++;
} finally {
  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
