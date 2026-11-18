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
        <h1>Public chain</h1>
        <div class="meta"><span data-scope>Solana devnet</span><span class="source" data-source>connecting</span></div>
      </header>
      <section class="tally">
        <div class="stat" data-stat="direct"><div class="k">Feed payments</div><div class="v">0</div></div>
        <div class="stat" data-stat="deposit"><div class="k">Vault deposits</div><div class="v">0</div></div>
        <div class="stat" data-stat="payout"><div class="k">Vault payouts</div><div class="v">0</div></div>
      </section>
      <section class="panel copycat">
        <div class="title">Copycat</div>
        <div data-readings></div>
      </section>
      <section class="panel feed">
        <div class="title">Transactions</div>
        <div class="rows" data-rows></div>
      </section>
      <footer>Blindfold purchases leave no transaction</footer>
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

  const span = (s) => (s === null || s === undefined ? "" : s < 60 ? `${Math.max(s, 1)}s` : `${Math.round(s / 60)}m`);

  function renderReadings() {
    const parts = [];
    for (const s of state.signals.values()) {
      const facts = [`${s.calls} paid ${s.calls === 1 ? "read" : "reads"}`, s.token ? `${s.tokenCalls} on ${s.token}` : "token unknown", span(s.spanSeconds)].filter(Boolean);
      parts.push(`
        <div class="reading alarm" title="${esc(s.reason)}">
          <div class="action">${esc(s.action)}</div>
          <div class="target">${who(s.payer)}</div>
          <div class="facts">${facts.map(esc).join('<span class="sep">·</span>')}</div>
        </div>`);
    }
    if (state.vault) {
      const v = state.vault;
      const facts = [`${v.depositors} ${v.depositors === 1 ? "depositor" : "depositors"}`, `${v.payouts} ${v.payouts === 1 ? "payout" : "payouts"}${v.payouts ? ` ${usd(v.payoutBase)}` : ""}`, "token unknown"];
      parts.push(`
        <div class="reading ${TONE[v.action] ?? ""}" title="${esc(v.reason)}">
          <div class="action">${esc(v.action)}</div>
          <div class="target"><span class="addr">Vault</span></div>
          <div class="facts">${facts.map(esc).join('<span class="sep">·</span>')}</div>
        </div>`);
    }
    $("[data-readings]").innerHTML = parts.length ? parts.join("") : `<div class="empty">No signal</div>`;
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
    rows.prepend(el);
    renderCounts();
  }

  function apply(e) {
    switch (e.type) {
      case "setup":
        state.labels = e.labels ?? {};
        $("[data-scope]").innerHTML = [`${esc(e.network)}`, ...(e.feeds ?? []).map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`), `<a href="${esc(e.vaultUrl)}" target="_blank" rel="noopener">Vault</a>`].join('<span class="sep">·</span>');
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
