// Renderer for the public chain view (watch.html). Events come from `pnpm watch` (scripts/watch.ts) over SSE; reset()
// runs on every (re)connect because the server replays its full history.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a ?? "");
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");
const KIND = { direct_payment: "PAYMENT", vault_deposit: "VAULT DEPOSIT", vault_payout: "VAULT PAYOUT" };
// Same pattern as parseMemo in scripts/lib/observer.ts: a seller's tag such as `whale-flow/SOL`.
const TAG = /^[a-z][a-z-]{0,31}\/[A-Z0-9]{1,16}$/;

/** Memos matter only on direct payments: a seller's tag names the token (red); anything else is a random nonce. */
function memoChip(e) {
  if (e.kind !== "direct_payment" || !e.memo) return "";
  return TAG.test(e.memo)
    ? `<span class="memo" title="Seller's memo in the same transaction: it names the feed and token">memo ${esc(e.memo)}</span>`
    : `<span class="memo nonce" title="Random nonce memo: it names nothing">memo: random nonce</span>`;
}

const TONE = { "NO SIGNAL": "calm", "CANNOT ATTRIBUTE": "calm", LINKED: "partial", PARTIAL: "partial" };

export function mountWatch(root) {
  root.innerHTML = `
    <div class="watch">
      <header>
        <div>
          <h1>What the chain shows</h1>
          <div class="sub" data-sub>Public Solana data only: the data feeds' USDC accounts and the Blindfold vault.</div>
        </div>
        <div class="source" data-source>connecting</div>
      </header>
      <section class="tally" aria-label="Counts">
        <div class="stat" data-stat="direct"><div class="k">Direct payments to feeds</div><div class="v">0</div></div>
        <div class="stat" data-stat="deposit"><div class="k">Vault deposits</div><div class="v">0</div></div>
        <div class="stat" data-stat="payout"><div class="k">Vault payouts</div><div class="v">0</div></div>
      </section>
      <section class="copycat" aria-label="Copycat">
        <div class="title"><span>Copycat, a front-running bot reading this page's data</span><span data-count></span></div>
        <div data-readings><div class="empty">Watching. Nothing to trade on yet.</div></div>
      </section>
      <section class="feed" aria-label="Transactions">
        <div class="title"><span>Transactions, newest first</span><span data-feeds></span></div>
        <div class="rows" data-rows><div class="empty">No transactions yet.</div></div>
      </section>
      <footer>Blindfold purchases are HTTP requests carrying ecash tokens. <b>They have no row on this page.</b></footer>
    </div>`;
  const $ = (sel) => root.querySelector(sel);
  let state;

  function reset() {
    state = { labels: {}, rows: [], seen: new Set(), signals: new Map(), vault: null, counts: { direct: 0, deposit: 0, payout: 0 } };
    $("[data-rows]").innerHTML = `<div class="empty">No transactions yet.</div>`;
    renderReadings();
    renderCounts();
  }

  const label = (wallet) => (state.labels[wallet] ? `<span class="tag">${esc(state.labels[wallet])}</span>` : "");

  function renderCounts() {
    for (const [k, n] of Object.entries(state.counts)) {
      const el = root.querySelector(`[data-stat="${k}"]`);
      el.querySelector(".v").textContent = n;
      el.classList.toggle("alarm", k === "direct" && n > 0);
    }
  }

  function renderReadings() {
    const parts = [];
    for (const s of state.signals.values()) {
      parts.push(`<div class="reading alarm"><div class="action">${esc(s.action)}</div><div class="who">on ${esc(short(s.payer))} ${label(s.payer)}</div><div class="reason">${esc(s.reason)}</div></div>`);
    }
    if (state.vault) {
      const v = state.vault;
      parts.push(`<div class="reading ${TONE[v.action] ?? ""}"><div class="action">${esc(v.action)}</div><div class="who">on the Blindfold vault</div><div class="reason">${esc(v.reason)}</div></div>`);
    }
    $("[data-readings]").innerHTML = parts.length ? parts.join("") : `<div class="empty">Watching. Nothing to trade on yet.</div>`;
    $("[data-count]").textContent = state.signals.size ? `${state.signals.size} wallet${state.signals.size === 1 ? "" : "s"} profiled` : "";
  }

  function addRow(e) {
    if (state.seen.has(e.signature + e.kind)) return;
    state.seen.add(e.signature + e.kind);
    state.counts[e.kind === "direct_payment" ? "direct" : e.kind === "vault_deposit" ? "deposit" : "payout"]++;
    const rows = $("[data-rows]");
    rows.querySelector(".empty")?.remove();
    const el = document.createElement("div");
    el.className = `row ${e.kind}`;
    el.innerHTML = `
      <div class="t">${hhmmss(e.time)}</div>
      <div class="kind">${KIND[e.kind] ?? esc(e.kind)}</div>
      <div class="text">${esc(e.text)}${e.kind === "direct_payment" ? label(e.from) : e.kind === "vault_deposit" ? label(e.from) : ""}${memoChip(e)}</div>
      <a class="x" href="${esc(e.url)}" target="_blank" rel="noopener" title="Open in Solana Explorer" aria-label="Open in Solana Explorer">&#8599;</a>`;
    rows.prepend(el);
    renderCounts();
  }

  function apply(e) {
    switch (e.type) {
      case "setup": {
        state.labels = e.labels ?? {};
        $("[data-sub]").innerHTML = `Public ${esc(e.network)} data only: the data feeds' USDC accounts and the <a href="${esc(e.vaultUrl)}" target="_blank" rel="noopener">Blindfold vault</a>.`;
        $("[data-feeds]").innerHTML = (e.feeds ?? []).map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join(" · ");
        break;
      }
      case "source": {
        const el = $("[data-source]");
        el.dataset.state = e.state;
        el.textContent = e.state === "streams" ? "live via QuickNode Streams" : e.state === "starting" ? "connecting Streams, polling RPC" : e.state === "fallback" ? "Streams quiet, polling RPC" : "polling RPC";
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
