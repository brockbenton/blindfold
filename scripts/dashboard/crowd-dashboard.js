// The crowd dashboard renderer, shared by the live page (crowd.html, fed over Server-Sent Events by `pnpm crowd`)
// and the replay (replay.html with a crowd recording). Event types: CrowdEvent in scripts/crowd.ts.
// Unknown event types are ignored. An event without a `url` renders without a link.

const MARKUP = `
<div class="app">
  <header>
    <h1>Blindfold<span class="q">Who is researching what?</span></h1>
    <span class="act" data-ref="act">Waiting for the demo</span>
  </header>
  <main>
    <section class="side exact">
      <div class="head"><span class="name">Standard x402</span><span class="scheme">exact</span></div>
      <div class="verdict"><div class="who">watcher's answer</div><div class="action">watching</div><div class="detail"></div></div>
      <div class="log">
        <div class="section"><span>wallets the observer profiled</span><span class="count">0 txs</span></div>
        <div class="rows"></div>
      </div>
      <div class="buys"><span class="label">purchases</span><div class="lanes"></div></div>
    </section>
    <section class="side blind">
      <div class="head"><span class="name">Blindfold</span><span class="scheme">blindfold</span></div>
      <div class="verdict"><div class="who">watcher's answer</div><div class="action">watching</div><div class="detail"></div></div>
      <div class="log">
        <div class="section"><span>the vault, as the observer sees it</span><span class="count">0 txs</span></div>
        <div class="rows"></div>
      </div>
      <div class="buys"><span class="label">purchases</span><div class="lanes"></div></div>
    </section>
  </main>
  <footer>
    <span>agents<b data-ref="b-agents">-</b></span>
    <span>agent tokens (offchain)<b data-ref="b-tokens">-</b></span>
    <span>feed earned<b data-ref="b-feed">-</b></span>
    <span>vault this run<b data-ref="b-vault">-</b></span>
  </footer>
</div>`;

const usd = (base) => "$" + (Number(base) / 1e6).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const shortAddr = (a) => String(a).slice(0, 4) + "…" + String(a).slice(-4);
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");
/** An <a> when there is a URL, otherwise a <div>, with the same class and content. */
const linkOr = (url, attrs, inner) =>
  url ? `<a ${attrs} href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>` : `<div ${attrs}>${inner}</div>`;

/**
 * Renders the crowd dashboard into `root`. Returns { reset, apply(event) }.
 * @param {HTMLElement} root
 */
export function mountCrowd(root) {
  root.classList.add("dashboard", "crowd");
  root.innerHTML = MARKUP;
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const ex = root.querySelector(".exact");
  const bl = root.querySelector(".blind");
  let state;

  function verdict(el, action, detail, tone) {
    const v = el.querySelector(".verdict");
    v.classList.remove("alarm", "calm", "warn");
    if (tone) v.classList.add(tone);
    v.querySelector(".action").textContent = action;
    v.querySelector(".detail").textContent = detail;
  }

  function reset() {
    state = { agents: [], exactTxs: 0, vaultTxs: 0, round1: false, round2: false, buys: { exact: [], blindfold: [] } };
    ref("act").textContent = "Waiting for the demo";
    for (const id of ["b-agents", "b-tokens", "b-feed", "b-vault"]) ref(id).textContent = "-";
    for (const el of [ex, bl]) {
      verdict(el, "watching", "no transactions yet");
      el.querySelector(".rows").innerHTML = '<div class="empty">waiting for transactions</div>';
      el.querySelector(".count").textContent = "0 txs";
      el.querySelector(".lanes").innerHTML = "";
    }
  }

  const lane = (side, i) => root.querySelector(`[data-lane="${side}-${i}"]`);
  const agentOf = (wallet) => state.agents.findIndex((a) => a.wallet === wallet);

  const handlers = {
    setup(e) {
      state.agents = e.agents;
      ref("b-agents").textContent = e.agents.map((a) => a.name + " " + a.token).join(" · ");
      for (const [side, el] of [["exact", ex], ["blindfold", bl]]) {
        el.querySelector(".lanes").innerHTML = e.agents.map((a, i) =>
          `<div class="lane" data-lane="${side}-${i}"><span class="who">Agent ${esc(a.name)}</span><span class="ticks"></span><span class="where">0</span></div>`).join("");
      }
    },
    act(e) { ref("act").textContent = e.title; },
    call(e) {
      const list = state.buys[e.side];
      list[e.agent] = (list[e.agent] || 0) + 1;
      const l = lane(e.side, e.agent);
      if (!l) return;
      l.querySelector(".ticks").insertAdjacentHTML("beforeend", e.url
        ? `<a class="tick" href="${esc(e.url)}" target="_blank" rel="noopener" title="${esc(e.label)}"></a>`
        : `<span class="tick" title="${esc(e.label)}"></span>`);
      l.querySelector(".where").textContent = list[e.agent] + (e.side === "exact" ? " · onchain" : " · offchain");
    },
    /* The observer's per-wallet profile from exact payments: the left table is rebuilt from it. */
    exact(e) {
      const sorted = [...e.signals].sort((a, b) => agentOf(a.payer) - agentOf(b.payer));
      ex.querySelector(".rows").innerHTML = sorted.map((s) => {
        const i = agentOf(s.payer);
        return '<div class="row" style="animation:none"><span class="agent">' + (i >= 0 ? "Agent " + esc(state.agents[i].name) : "?") +
          '</span><span class="addr">' + esc(shortAddr(s.payer)) + '</span><span class="token">' + esc(s.token ? "researching " + s.token : "token unknown") +
          '</span><span class="calls">' + Number(s.calls) + ' reads</span><span class="sig">' + esc(s.action) + "</span></div>";
      }).join("") || '<div class="empty">waiting for transactions</div>';
      const named = e.signals.filter((s) => s.token).length;
      verdict(ex, named + " of " + state.agents.length + " named", sorted.map((s) => {
        const i = agentOf(s.payer);
        return (i >= 0 ? state.agents[i].name : "?") + " → " + (s.token || "?");
      }).join(" · ") + (e.final ? " · every wallet tied to its token" : ""), "alarm");
    },
    chain(e) {
      if (e.kind === "direct_payment") {
        state.exactTxs++;
        ex.querySelector(".count").textContent = state.exactTxs + (state.exactTxs === 1 ? " tx" : " txs");
        return;
      }
      state.vaultTxs++;
      const rows = bl.querySelector(".rows");
      rows.querySelector(".empty")?.remove();
      if (e.round === 2 && !state.round2) {
        state.round2 = true;
        rows.insertAdjacentHTML("beforeend", '<div class="divider">round 2 · uneven amounts</div>');
      }
      rows.insertAdjacentHTML("beforeend", e.kind === "vault_payout"
        ? linkOr(e.url, 'class="row payout"', "<time>" + hhmmss(e.time) + '</time><span class="what">vault → feed, batched</span><span class="unknown">payer unknown</span><span class="amt">' + usd(e.amountBase) + "</span>")
        : linkOr(e.url, `class="row" data-from="${esc(e.from)}" data-round="${Number(e.round)}"`, "<time>" + hhmmss(e.time) + "</time><span>deposit " + esc(shortAddr(e.from)) +
          '</span><span class="unknown">agent ? · bought ?</span><span class="amt">' + usd(e.amountBase) + "</span>"));
      rows.scrollTop = rows.scrollHeight;
      bl.querySelector(".count").textContent = state.vaultTxs + (state.vaultTxs === 1 ? " tx" : " txs");
    },
    vault(e) {
      if (e.action === "CANNOT ATTRIBUTE") {
        state.round1 = true;
        verdict(bl, "can't tell", "deposits in, one payout out: who bought what, and which token, unknown", "calm");
      } else if (e.action === "NO SIGNAL") verdict(bl, "no signal", e.reason, "calm");
      else if (e.action === "PARTIAL") {
        verdict(bl, "amounts leak", (state.round1 ? "Equal deposits: can't tell. " : "") + "Uneven deposits: " + shortAddr(e.forced[0]) + " must have paid the feed. Token: unknown", "warn");
        for (const r of bl.querySelectorAll(`.row[data-round="${Number(e.round)}"]`)) {
          if (!e.forced.includes(r.dataset.from)) continue;
          r.classList.add("forced");
          r.querySelector(".unknown").textContent = "must have paid the feed";
        }
      } else verdict(bl, String(e.action).toLowerCase(), e.reason, "alarm");
    },
    tokens(e) { ref("b-tokens").textContent = e.cents.map((c, i) => (state.agents[i]?.name ?? "?") + " $" + (c / 100).toFixed(2)).join(" · "); },
    feed(e) { ref("b-feed").textContent = usd(e.earnedBase); ref("b-vault").textContent = "+" + usd(e.vaultBase); },
    done(e) { ref("act").textContent = e.ok ? "Done" : "Stopped"; },
  };

  /** Applies one event. A bad or unknown event is skipped, never fatal. */
  function apply(e) {
    if (!e || typeof e !== "object" || !Object.hasOwn(handlers, e.type)) return;
    try {
      handlers[e.type](e);
    } catch (err) {
      console.warn("crowd dashboard: could not render event", e, err);
    }
  }

  reset();
  return { reset, apply, interactive: false };
}
