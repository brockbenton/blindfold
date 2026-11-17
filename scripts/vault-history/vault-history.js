// Vault history: reads the Blindfold vault's whole onchain record from Solana RPC in the browser. Nothing here is
// served by Blindfold; the page needs only an RPC endpoint. Results are cached in localStorage, so a reload asks
// the RPC only for transactions newer than the last visit.
"use strict";

const params = new URLSearchParams(location.search);
const RPC = params.get("rpc") || "https://api.devnet.solana.com";
const PROGRAM = params.get("program") || "EsB6NfKVPipU5kEVm2jq14cjopbE7w9hPEFZWVu8jtMo";
const USDC = params.get("usdc") || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CACHE_KEY = `bf-vault-history:v2:${new URL(RPC).host}:${PROGRAM}`;
/** Minimum spacing between RPC requests; the public devnet RPC rate-limits bursts. */
const GAP_MS = 300;
const CONCURRENCY = 2;

/** Anchor event discriminators: sha256("event:<Name>")[0..8]. */
const EVENTS = {
  d2c982b7f4cb9bc7: "DepositMade",
  "26d1894eb913930e": "ProviderRegistered",
  "881f626db8ff7bde": "ProviderDeactivated",
  ee0ebbc07f5f6809: "BatchSettled",
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "");
const usd = (base) => {
  const b = BigInt(base);
  const neg = b < 0n;
  const a = neg ? -b : b;
  const cents = (a + 5000n) / 10000n;
  return `${neg ? "−" : ""}$${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
};
const signed = (base) => (BigInt(base) > 0n ? `+${usd(base)}` : usd(base));
const cluster = (() => {
  if (/devnet/i.test(RPC)) return "?cluster=devnet";
  if (/mainnet/i.test(RPC)) return "";
  if (/testnet/i.test(RPC)) return "?cluster=testnet";
  return `?cluster=custom&customUrl=${encodeURIComponent(RPC)}`;
})();
const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}${cluster}`;
const explorerAddr = (a) => `https://explorer.solana.com/address/${a}${cluster}`;
const fmtTime = (t) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16) : "pending");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ------------------------------------------------------------------------------------------------ RPC

let nextSlot = 0;
async function rpc(method, rpcParams, tries = 8) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Date.now() + wait + GAP_MS;
    if (wait) await sleep(wait);
    let retry = false;
    try {
      const r = await fetch(RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: rpcParams }),
      });
      if (r.status === 429 || r.status >= 500) { retry = true; throw new Error(`RPC HTTP ${r.status}`); }
      const j = await r.json();
      if (j.error) {
        retry = j.error.code === 429 || /rate|too many/i.test(j.error.message || "");
        throw new Error(`RPC ${method}: ${j.error.message}`);
      }
      return j.result;
    } catch (e) {
      if (e instanceof TypeError) retry = true; // network error or CORS hiccup
      if (!retry || attempt >= tries) throw e;
      await sleep(Math.min(10_000, 1000 * 2 ** attempt));
    }
  }
}

/** All signatures for an address, newest first, stopping at `until` (exclusive). */
async function signatures(address, until) {
  const out = [];
  let before;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [address, { limit: 1000, before, until, commitment: "confirmed" }]);
    out.push(...page);
    if (page.length < 1000) return out;
    before = page[page.length - 1].signature;
  }
}

async function pool(items, worker, onProgress) {
  let i = 0;
  let done = 0;
  const run = async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
      onProgress(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
}

// ------------------------------------------------------------------------------------------------ decoding

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const pk = (b) => new solanaWeb3.PublicKey(b).toBase58();

function decodeEvent(data) {
  const b = b64bytes(data);
  const name = EVENTS[hex(b.subarray(0, 8))];
  if (!name) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u64 = (o) => v.getBigUint64(o, true).toString();
  switch (name) {
    case "DepositMade": return { name, index: u64(8), depositor: pk(b.subarray(16, 48)), amount: u64(48) };
    case "ProviderRegistered": return { name, providerId: v.getUint32(8, true), payoutToken: pk(b.subarray(45, 77)) };
    case "ProviderDeactivated": return { name, providerId: v.getUint32(8, true) };
    case "BatchSettled": return { name, batchId: u64(8), total: u64(16), count: b[24] };
  }
  return null;
}

/** A compact, cacheable summary of one vault transaction. */
function summarize(sig, tx, vaultToken) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const logs = tx.meta.logMessages || [];
  const names = [];
  const events = [];
  for (let i = 0; i < logs.length; i++) {
    if (logs[i].startsWith(`Program ${PROGRAM} invoke`)) {
      const m = /^Program log: Instruction: (\w+)/.exec(logs[i + 1] || "");
      if (m) names.push(m[1]);
    } else if (logs[i].startsWith("Program data: ")) {
      try {
        const e = decodeEvent(logs[i].slice(14));
        if (e) events.push(e);
      } catch { /* not ours */ }
    }
  }
  const byIndex = new Map();
  for (const [field, list] of [["pre", tx.meta.preTokenBalances || []], ["post", tx.meta.postTokenBalances || []]]) {
    for (const t of list) {
      if (t.mint !== USDC) continue;
      const row = byIndex.get(t.accountIndex) || { account: keys[t.accountIndex], owner: t.owner, pre: 0n, post: 0n };
      row[field] = BigInt(t.uiTokenAmount.amount);
      byIndex.set(t.accountIndex, row);
    }
  }
  let vaultDelta = 0n;
  const others = [];
  for (const r of byIndex.values()) {
    const d = r.post - r.pre;
    if (r.account === vaultToken) vaultDelta = d;
    else if (d !== 0n) others.push({ account: r.account, owner: r.owner, delta: d.toString() });
  }
  const loader = logs.some((l) => l.startsWith("Program BPFLoaderUpgradeab1e11111111111111111111111 invoke"));
  return { sig, slot: tx.slot, time: tx.blockTime, names, events, vaultDelta: vaultDelta.toString(), others, signer: keys[0], loader };
}

function classify(s, providerByAccount) {
  const n = s.names;
  const ev = (name) => s.events.find((e) => e.name === name);
  if (n.includes("Deposit")) {
    const e = ev("DepositMade");
    const who = e ? e.depositor : s.signer;
    return { kind: "deposit", label: "deposit", detail: `deposit #${e ? e.index : "?"} from <a href="${explorerAddr(who)}" target="_blank" rel="noopener">${short(who)}</a>` };
  }
  if (n.includes("SettleBatch")) {
    const e = ev("BatchSettled");
    const paid = s.others.filter((o) => BigInt(o.delta) > 0n).map((o) => {
      const id = providerByAccount.get(o.account);
      return `${id !== undefined ? `provider ${id}` : short(o.owner || o.account)} ${signed(o.delta)}`;
    });
    return { kind: "settle", label: "settlement", detail: `batch ${e ? e.batchId : "?"}: ${paid.join(", ") || "payouts"}` };
  }
  if (n.includes("RegisterProvider")) {
    const e = ev("ProviderRegistered");
    return { kind: "provider", label: "provider added", detail: e ? `provider ${e.providerId}, payout account <a href="${explorerAddr(e.payoutToken)}" target="_blank" rel="noopener">${short(e.payoutToken)}</a>` : "provider registered" };
  }
  if (n.includes("DeactivateProvider")) {
    const e = ev("ProviderDeactivated");
    return { kind: "provider", label: "provider removed", detail: e ? `provider ${e.providerId} deactivated` : "provider deactivated" };
  }
  if (n.includes("Initialize")) return { kind: "other", label: "vault created", detail: `initialized by ${short(s.signer)}` };
  const issuance = n.find((x) => /issu/i.test(x));
  if (issuance) return { kind: "other", label: "issuance log", detail: `${issuance} by the mint authority` };
  if (n.length) return { kind: "other", label: n.join(", "), detail: "" };
  if (s.loader) return { kind: "other", label: "program deploy", detail: `vault program deployed or upgraded by ${short(s.signer)}` };
  if (BigInt(s.vaultDelta) !== 0n) return { kind: "other", label: "direct transfer", detail: `USDC sent straight to the vault account by ${short(s.signer)}` };
  return { kind: "other", label: "other", detail: "" };
}

// ------------------------------------------------------------------------------------------------ cache

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (c && c.txs && c.newest) return c;
  } catch { /* storage blocked or corrupt */ }
  return { txs: {}, newest: {} };
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* full or blocked: fine, just slower next time */ }
}

// ------------------------------------------------------------------------------------------------ render

let rows = [];
let filter = "all";
/** The last rendered data, for redrawing the chart on resize without asking the RPC again. */
let last = null;

function renderTotals(current, list, providerCount) {
  let deposited = 0n, paid = 0n, deposits = 0, batches = 0;
  for (const r of list) {
    const d = BigInt(r.s.vaultDelta);
    if (r.c.kind === "deposit") { deposited += d; deposits++; }
    if (r.c.kind === "settle") { paid -= d; batches++; }
  }
  $("t-held").textContent = usd(current);
  $("t-in").textContent = usd(deposited);
  $("t-in-n").textContent = `${deposits} deposit${deposits === 1 ? "" : "s"}`;
  $("t-out").textContent = usd(paid);
  $("t-out-n").textContent = `${batches} batch${batches === 1 ? "" : "es"}`;
  $("t-prov").textContent = String(providerCount.active);
  $("t-prov-n").textContent = `active, ${providerCount.registered} registered`;
}

function renderRows() {
  const shown = rows.filter((r) => filter === "all" || r.c.kind === filter);
  $("rows").innerHTML = shown.map((r) => {
    const d = BigInt(r.s.vaultDelta);
    return `<tr>
      <td class="time">${fmtTime(r.s.time)}</td>
      <td class="kind kind-${r.c.kind}">${esc(r.c.label)}</td>
      <td class="detail">${r.c.detail}</td>
      <td class="num ${d > 0n ? "in" : d < 0n ? "out" : ""}">${d === 0n ? "" : signed(d)}</td>
      <td class="num">${usd(r.balance)}</td>
      <td class="link"><a href="${explorerTx(r.s.sig)}" target="_blank" rel="noopener">tx</a></td>
    </tr>`;
  }).join("");
  $("empty").hidden = shown.length > 0;
  $("count").textContent = `${shown.length} of ${rows.length} transactions`;
}

function renderChart(asc, current) {
  const el = $("chart");
  const pts = asc.filter((r) => r.s.time).map((r) => ({ t: r.s.time, v: Number(BigInt(r.balance)) / 1e6, d: BigInt(r.s.vaultDelta), r }));
  if (!pts.length) { el.innerHTML = `<p class="empty">No balance history yet.</p>`; return; }
  const now = Math.floor(Date.now() / 1000);
  pts.push({ t: now, v: Number(BigInt(current)) / 1e6, d: 0n, r: null });
  const W = el.clientWidth || 800, H = el.clientHeight || 220, L = 56, R = 8, T = 8, B = 24;
  const t0 = pts[0].t, t1 = Math.max(now, t0 + 1);
  const vmax = Math.max(...pts.map((p) => p.v), 0.01) * 1.15;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / vmax) * (H - T - B);
  let path = `M${x(pts[0].t)},${y(0)} L${x(pts[0].t)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) path += ` L${x(pts[i].t)},${y(pts[i - 1].v)} L${x(pts[i].t)},${y(pts[i].v)}`;
  const area = `${path} L${x(pts[pts.length - 1].t)},${y(0)} Z`;
  const grid = [0, 0.5, 1].map((f) => {
    const v = vmax * f / 1.15;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">$${v.toFixed(v >= 10 ? 0 : 2)}</text>`;
  }).join("");
  const day = (t) => new Date(t * 1000).toISOString().slice(5, 10);
  const xl = [t0, (t0 + t1) / 2, t1].map((t, i) => `<text class="axis" x="${x(t)}" y="${H - 4}" text-anchor="${["start", "middle", "end"][i]}">${day(t)}</text>`).join("");
  const dots = pts.filter((p) => p.d !== 0n).map((p) => `<circle class="${p.d > 0n ? "dot-in" : "dot-out"}" cx="${x(p.t)}" cy="${y(p.v)}" r="2.5"/>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vault USDC balance over time">${grid}${xl}<path class="area" d="${area}"/><path class="line" d="${path}"/>${dots}<line class="hover" id="hover" y1="${T}" y2="${H - B}" visibility="hidden"/></svg><div class="tip" id="tip" hidden></div>`;
  $("chart-range").textContent = `${fmtTime(t0).slice(0, 10)} to now`;
  const svg = el.querySelector("svg"), hover = $("hover"), tip = $("tip");
  svg.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    hover.setAttribute("x1", x(best.t)); hover.setAttribute("x2", x(best.t)); hover.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.style.left = `${(x(best.t) / W) * box.width}px`;
    tip.style.top = `${(y(best.v) / H) * box.height}px`;
    tip.innerHTML = `$${best.v.toFixed(2)} <span class="d">${best.r ? `${esc(best.r.c.label)} ${best.d ? signed(best.d) : ""} · ${fmtTime(best.t)}` : "now"}</span>`;
  });
  svg.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });
}

async function renderIssuance(issuancePda, list) {
  const info = await rpc("getAccountInfo", [issuancePda, { encoding: "base64", commitment: "confirmed" }]).catch(() => null);
  const updates = list.filter((r) => r.c.label === "issuance log");
  if (!info?.value && !updates.length) { $("issuance-panel").hidden = true; return; }
  $("issuance-panel").hidden = false;
  const last = updates[0];
  const size = info?.value ? b64bytes(info.value.data[0]).length : 0;
  $("issuance").innerHTML = [
    info?.value ? `The mint publishes its issuance totals to <a href="${explorerAddr(issuancePda)}" target="_blank" rel="noopener">${short(issuancePda)}</a> (${size} bytes).` : "The issuance account is not present.",
    `${updates.length} update${updates.length === 1 ? "" : "s"} on record.`,
    last ? `Last: ${fmtTime(last.s.time)} UTC, <a href="${explorerTx(last.s.sig)}" target="_blank" rel="noopener">tx</a>.` : "",
  ].join(" ");
  $("issuance-age").textContent = last ? fmtTime(last.s.time) : "";
}

// ------------------------------------------------------------------------------------------------ main

let busy = false;
async function load() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  const status = $("status");
  status.className = "";
  try {
    if (typeof solanaWeb3 === "undefined") throw new Error("could not load @solana/web3.js from jsdelivr");
    const { PublicKey } = solanaWeb3;
    const program = new PublicKey(PROGRAM);
    const enc = (s) => new TextEncoder().encode(s);
    const config = PublicKey.findProgramAddressSync([enc("config")], program)[0];
    const vaultToken = PublicKey.findProgramAddressSync([config.toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), new PublicKey(USDC).toBytes()], new PublicKey(ATA_PROGRAM))[0].toBase58();
    const issuancePda = PublicKey.findProgramAddressSync([enc("issuance")], program)[0].toBase58();
    $("vault").textContent = short(vaultToken);
    $("vault").href = explorerAddr(vaultToken);

    const cache = loadCache();
    status.textContent = "reading signatures";
    const sigs = new Map();
    for (const addr of [PROGRAM, vaultToken]) {
      const list = await signatures(addr, cache.newest[addr]);
      if (list.length) cache.newest[addr] = list[0].signature;
      for (const s of list) if (!s.err) sigs.set(s.signature, s);
    }
    const missing = [...sigs.keys()].filter((s) => !cache.txs[s]);
    await pool(missing, async (sig) => {
      const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      if (tx && !tx.meta?.err) cache.txs[sig] = summarize(sig, tx, vaultToken);
    }, (done, total) => {
      status.textContent = `reading transactions ${done} / ${total}`;
      if (done % 25 === 0) saveCache(cache);
    });
    saveCache(cache);

    const current = BigInt((await rpc("getTokenAccountBalance", [vaultToken, { commitment: "confirmed" }])).value.amount);
    const all = Object.values(cache.txs).sort((a, b) => a.slot - b.slot || (a.time || 0) - (b.time || 0));
    const providerByAccount = new Map();
    const count = { registered: 0, active: 0 };
    for (const s of all) for (const e of s.events) {
      if (e.name === "ProviderRegistered") { providerByAccount.set(e.payoutToken, e.providerId); count.registered++; count.active++; }
      if (e.name === "ProviderDeactivated") count.active--;
    }
    // Balances backwards from the live balance, so a gap in history can't skew the latest numbers.
    let bal = current;
    const asc = all.map((s) => ({ s, c: classify(s, providerByAccount), balance: "0" }));
    for (let i = asc.length - 1; i >= 0; i--) { asc[i].balance = bal.toString(); bal -= BigInt(asc[i].s.vaultDelta); }
    rows = asc.slice().reverse();
    renderTotals(current, asc, count);
    last = { asc, current };
    renderChart(asc, current);
    renderRows();
    await renderIssuance(issuancePda, rows);
    status.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    status.className = "err";
    status.textContent = `${e.message || e}${/devnet\.solana/.test(RPC) ? " (the public RPC rate-limits; try again or add ?rpc=)" : ""}`;
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}

$("program").textContent = short(PROGRAM);
$("program").href = explorerAddr(PROGRAM);
$("network").textContent = /devnet/i.test(RPC) ? "Solana devnet" : new URL(RPC).host;
$("refresh").addEventListener("click", load);
for (const b of document.querySelectorAll(".filters button")) {
  b.addEventListener("click", () => {
    filter = b.dataset.f;
    for (const o of document.querySelectorAll(".filters button")) o.classList.toggle("on", o === b);
    renderRows();
  });
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => last && renderChart(last.asc, last.current), 200); });
load();
setInterval(() => { if (!document.hidden) load(); }, 60_000);
