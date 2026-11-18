// Renderer for the public chain view (watch.html). Events come from `pnpm watch` (scripts/watch.ts) over SSE; reset()
// runs on every (re)connect because the server replays its full history. Copycat's full reasoning is in each
// reading's tooltip; the page itself shows only the facts.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a ?? "");
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");
const usd = (base) => `$${(Number(base) / 1e6).toFixed(2)}`;
const KIND = { direct_payment: "Payment", vault_deposit: "Deposit", vault_payout: "Payout" };
const TONE = { "NO SIGNAL": "calm", "CANNOT ATTRIBUTE": "calm", LINKED: "warn", PARTIAL: "warn" };
// Same pattern as parseMemo in scripts/lib/observer.ts: a seller's tag such as `whale-flow/SOL`.
const TAG = /^[a-z][a-z-]{0,31}\/[A-Z0-9]{1,16}$/;

export function mountWatch(root) {
  root.innerHTML = `
    <div class="watch">
      <header>
        <h1>Blindfold</h1>
        <div class="meta"><span data-scope></span><span class="source" data-source>connecting</span></div>
      </header>
      <section class="tally">
        <div class="stat" data-stat="direct"><div class="k">Feed payments</div><div class="v">0</div></div>
        <div class="stat" data-stat="deposit"><div class="k">Vault deposits</div><div class="v">0</div></div>
        <div class="stat" data-stat="payout"><div class="k">Vault payouts</div><div class="v">0</div></div>
      </section>
      <section class="panel copycat">
        <div class="title">Copycat</div>
        <div class="sides">
          <div class="side"><div class="side-name">Standard x402</div><div data-readings="exact"></div></div>
          <div class="side"><div class="side-name">Blindfold</div><div data-readings="blind"></div></div>
        </div>
      </section>
      <section class="panel feed">
        <div class="title">Transactions</div>
        <div class="rows" data-rows></div>
      </section>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  let state;

  function reset() {
    state = { labels: {}, seen: new Set(), signals: new Map(), vault: null, counts: { direct: 0, deposit: 0, payout: 0 } };
    $("[data-rows]").innerHTML = `<div class="empty">Waiting for transactions</div>`;
    renderReadings();
    renderCounts();
  }

  const who = (wallet) => `<span class="addr">${esc(short(wallet))}</span>${state.labels[wallet] ? `<span class="label">${esc(state.labels[wallet])}</span>` : ""}`;

  function renderCounts() {
    for (const [k, n] of Object.entries(state.counts)) {
      const el = root.querySelector(`[data-stat="${k}"]`);
      el.querySelector(".v").textContent = n;
      el.classList.toggle("alarm", k === "direct" && n > 0);
    }
  }

  const span = (s) => (s === null || s === undefined ? "" : s < 120 ? `${Math.max(s, 1)}s` : `${Math.round(s / 60)}m`);
  const facts = (list) => `<div class="facts">${list.filter(Boolean).map(esc).join('<span class="sep">·</span>')}</div>`;

  function renderReadings() {
    // Standard x402: every wallet that paid a feed directly, labelled ones (the rival) first.
    const signals = [...state.signals.values()].sort((a, b) => Number(!state.labels[a.payer]) - Number(!state.labels[b.payer]) || b.calls - a.calls);
    $('[data-readings="exact"]').innerHTML = signals.length
      ? signals.map((s) => `
        <div class="reading alarm" title="${esc(s.reason)}">
          <div class="action">${esc(s.action)}</div>
          <div class="target">${who(s.payer)}</div>
          ${facts([`${s.calls} paid ${s.calls === 1 ? "read" : "reads"}`, s.token ? `${s.tokenCalls} on ${s.token}` : "token unknown", span(s.spanSeconds)])}
        </div>`).join("")
      : `<div class="reading"><div class="action">NO SIGNAL</div><div class="target">No direct payments</div>${facts([])}</div>`;
    // Blindfold: the vault reading. The agent has no wallet, so it never appears as a payer.
    const v = state.vault;
    $('[data-readings="blind"]').innerHTML = `
      <div class="reading ${v ? TONE[v.action] ?? "" : "calm"}" title="${esc(v?.reason ?? "No vault activity in view")}">
        <div class="action">${esc(v?.action ?? "NO SIGNAL")}</div>
        <div class="target">No agent wallet · 0 per-call transactions</div>
        ${facts(v ? [`${v.depositors} ${v.depositors === 1 ? "depositor" : "depositors"}`, `${v.payouts} ${v.payouts === 1 ? "payout" : "payouts"}${v.payouts ? ` ${usd(v.payoutBase)}` : ""}`, "token unknown"] : ["token unknown"])}
      </div>`;
  }

  function memo(e) {
    if (e.kind !== "direct_payment" || !e.memo) return "";
    return TAG.test(e.memo) ? `<span class="memo" title="Seller memo, onchain">${esc(e.memo)}</span>` : "";
  }

  function addRow(e) {
    const key = e.signature + e.kind;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.counts[e.kind === "direct_payment" ? "direct" : e.kind === "vault_deposit" ? "deposit" : "payout"]++;
    const rows = $("[data-rows]");
    rows.querySelector(".empty")?.remove();
    const from = e.kind === "vault_payout" ? `<span class="addr">Vault</span>` : who(e.from);
    const el = document.createElement("a");
    el.dataset.time = e.time ?? "";
    el.className = `row ${e.kind}`;
    el.href = e.url;
    el.target = "_blank";
    el.rel = "noopener";
    el.title = "Open in Solana Explorer";
    el.innerHTML = `
      <span class="t">${hhmmss(e.time)}</span>
      <span class="kind">${KIND[e.kind] ?? esc(e.kind)}</span>
      <span class="flow">${from}<span class="arrow">→</span><span class="addr">${esc(e.toName ?? short(e.to))}</span>${memo(e)}</span>
      <span class="amt">${usd(e.amountBase)}</span>`;
    // Newest first. History arrives one account at a time, so insert by time rather than arrival order.
    const later = [...rows.children].find((x) => (x.dataset.time ?? "") < (e.time ?? ""));
    rows.insertBefore(el, later ?? null);
    renderCounts();
  }

  function apply(e) {
    switch (e.type) {
      case "setup":
        state.labels = e.labels ?? {};
        $("[data-scope]").innerHTML = [...(e.feeds ?? []).map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`), `<a href="${esc(e.vaultUrl)}" target="_blank" rel="noopener">Vault</a>`].join('<span class="sep">·</span>');
        break;
      case "source": {
        const el = $("[data-source]");
        el.dataset.state = e.state;
        el.textContent = e.state === "streams" ? "Live · QuickNode Streams" : "Live · RPC";
        el.title = e.text;
        break;
      }
      case "tx": addRow(e); break;
      case "signal": state.signals.set(e.payer, e); renderReadings(); break;
      case "vault": state.vault = e; renderReadings(); break;
      default: break; // unknown event types are ignored
    }
  }

  reset();
  return { apply, reset };
}
