// The dashboard renderer, shared by the live page (index.html, fed over Server-Sent Events) and the replay
// (replay.html, fed from a recording). Event types come from scripts/lib/dashboard.ts.
//
// Adding an event type: add a handler below. Unknown types never break the page: one with a `text` is shown as a
// quiet note, anything else is ignored. Controls that act on the live demo (an approve button, say) must be a
// <button> or carry data-live-control, and should check `ctx.interactive`: in a replay they are inert.

const MARKUP = `
<div class="app">
  <header>
    <h1>Blindfold</h1>
    <div class="approval" data-ref="approval" hidden>
      <span>owner approval: <b data-ref="ap-what"></b></span>
      <button class="yes" data-ref="ap-yes">Approve</button><button data-ref="ap-no">Deny</button>
      <span class="left" data-ref="ap-left"></span>
    </div>
    <span class="act" data-ref="act">Waiting for the demo</span>
  </header>
  <main>
    ${side("exact", "Standard x402", "exact")}
    ${side("blind", "Blindfold", "blindfold")}
  </main>
  <footer>
    <span>agent wallet<b data-ref="b-exact">-</b></span>
    <span>agent tokens<b data-ref="b-tokens">-</b></span>
    <span>feeds earned<b data-ref="b-provider">-</b></span>
    <span>vault balance<b data-ref="b-vault">-</b></span>
    <span>watcher reads<b data-ref="b-source">RPC polling</b></span>
  </footer>
</div>`;

function side(cls, name, scheme) {
  return `
    <section class="side ${cls}">
      <div class="head"><span class="name">${name}</span><span class="scheme">${scheme}</span></div>
      <div class="verdict"><div class="who">watcher's signal</div><div class="action">watching</div><div class="detail"></div></div>
      <div class="log">
        <div class="section"><span>onchain</span><span class="count">0 txs</span></div>
        <div class="rows"></div>
      </div>
      <div>
        <div class="notes"></div>
        <div class="buys"><span class="label">purchases</span><span class="ticks"></span><span class="where">0</span></div>
      </div>
    </section>`;
}

const usd = (base) => "$" + (Number(base) / 1e6).toFixed(2);
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const shortAddr = (a) => String(a).slice(0, 4) + "…" + String(a).slice(-4);
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");

/**
 * Renders the dashboard into `root`. Returns { reset, apply(event), interactive }.
 * @param {HTMLElement} root
 * @param {{ interactive?: boolean }} [options] false for a replay: live controls are inert.
 */
export function mountDashboard(root, { interactive = true } = {}) {
  root.classList.add("dashboard");
  root.innerHTML = MARKUP;
  if (!interactive) {
    root.dataset.replay = "";
    const block = (e) => {
      if (e.target instanceof Element && e.target.closest("button, input, select, textarea, form, [data-live-control]")) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    for (const t of ["click", "submit", "keydown", "change"]) root.addEventListener(t, block, true);
  }
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const sideEl = (s) => root.querySelector(s === "exact" ? ".exact" : ".blind");
  const ctx = { interactive };
  let state;
  /* Owner approval requests (live demo Act 6). The bar's buttons post the answer back; in a replay they are inert. */
  let approvals = {}, approvalId = null, approvalTimer;
  const hideApproval = () => { ref("approval").hidden = true; clearInterval(approvalTimer); approvalId = null; };
  const answer = (approve) => {
    if (!ctx.interactive || !approvalId) return;
    fetch("approval/" + encodeURIComponent(approvalId), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve }) });
  };
  ref("ap-yes").onclick = () => answer(true);
  ref("ap-no").onclick = () => answer(false);

  function reset() {
    state = { exact: { txs: [], buys: 0 }, blindfold: { txs: [], buys: 0 } };
    approvals = {};
    hideApproval();
    ref("act").textContent = "Waiting for the demo";
    for (const id of ["b-exact", "b-tokens", "b-provider", "b-vault"]) ref(id).textContent = "-";
    ref("b-source").textContent = "RPC polling";
    for (const s of ["exact", "blindfold"]) {
      const el = sideEl(s);
      el.querySelector(".verdict").classList.remove("on");
      el.querySelector(".action").textContent = "watching";
      el.querySelector(".detail").textContent = "no transactions yet";
      el.querySelector(".rows").innerHTML = '<div class="empty">waiting for transactions</div>';
      el.querySelector(".count").textContent = "0 txs";
      el.querySelector(".ticks").innerHTML = "";
      el.querySelector(".where").textContent = "0";
      el.querySelector(".notes").innerHTML = "";
    }
  }

  /* What Copycat can say about the agent, from the exact payments it has seen. */
  function exactDetail() {
    const txs = state.exact.txs.filter((t) => t.kind === "direct_payment");
    if (!txs.length) return "no transactions yet";
    const tags = txs.map((t) => /^([a-z-]+)\/([A-Z0-9]+)$/.exec(t.memo || "")).filter(Boolean);
    const feed = tags.length ? tags[0][1] : "paid";
    const token = tags.length ? " on " + tags[0][2] : "";
    const times = txs.map((t) => t.time && Date.parse(t.time)).filter(Boolean);
    const span = times.length > 1 ? " in " + Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 1000)) + " s" : "";
    return txs.length + " " + feed + " read" + (txs.length === 1 ? "" : "s") + token + span + " · wallet " + shortAddr(txs[0].from);
  }

  const note = (s, text, cls = "") =>
    sideEl(s).querySelector(".notes").insertAdjacentHTML("beforeend", '<div class="note' + (cls ? " " + cls : "") + '">' + esc(text) + "</div>");

  const handlers = {
    act(e) { ref("act").textContent = e.title; },
    call(e) {
      const s = state[e.side];
      s.buys++;
      const el = sideEl(e.side);
      const tick = e.url
        ? '<a class="tick" href="' + esc(e.url) + '" target="_blank" rel="noopener" title="' + esc(e.label) + '"></a>'
        : '<span class="tick" title="' + esc(e.label) + '"></span>';
      el.querySelector(".ticks").insertAdjacentHTML("beforeend", tick);
      el.querySelector(".where").textContent = s.buys + (e.side === "exact" ? " · onchain" : " · offchain");
    },
    chain(e) {
      const s = state[e.side];
      s.txs.push(e);
      const el = sideEl(e.side);
      const rows = el.querySelector(".rows");
      rows.querySelector(".empty")?.remove();
      let who, memo = "";
      if (e.kind === "direct_payment") {
        who = '<span class="addr">' + esc(shortAddr(e.from)) + "</span> → feed";
        memo = e.memo && e.memo.includes("/") ? esc(e.memo) : "";
      } else if (e.kind === "vault_payout") {
        who = 'vault → feed <span class="unknown">· payer unknown</span>';
      } else {
        who = 'deposit <span class="unknown">· ' + esc(shortAddr(e.from)) + "</span>";
      }
      const inner = "<time>" + hhmmss(e.time) + "</time><span>" + who + '</span><span class="memo">' + memo + '</span><span class="amt">' + usd(e.amountBase) + "</span>";
      rows.insertAdjacentHTML("afterbegin", e.url
        ? '<a class="row" href="' + esc(e.url) + '" target="_blank" rel="noopener">' + inner + "</a>"
        : '<div class="row">' + inner + "</div>");
      el.querySelector(".count").textContent = s.txs.length + (s.txs.length === 1 ? " tx" : " txs");
      if (e.side === "exact") el.querySelector(".detail").textContent = exactDetail();
    },
    copycat(e) {
      const el = sideEl(e.side);
      el.querySelector(".verdict").classList.add("on");
      el.querySelector(".action").textContent = e.side === "exact" ? e.action : "no signal";
      el.querySelector(".detail").textContent = e.side === "exact" ? exactDetail() : "nothing onchain names your agent";
    },
    balances(e) {
      ref("b-exact").textContent = usd(e.exactWalletBase);
      ref("b-tokens").textContent = "$" + (e.agentTokensCents / 100).toFixed(2);
      ref("b-provider").textContent = usd(BigInt(e.providerDirectBase) + BigInt(e.providerSettledBase) + BigInt(e.providerOwedCents) * 10000n);
      ref("b-vault").textContent = usd(e.vaultBase);
    },
    reserve(e) {
      const status = e.url
        ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener" title="IssuanceLog on Solana Explorer">' + esc(e.text) + '</a>'
        : esc(e.text);
      const tone = e.ok && e.verified ? "" : " warn";
      sideEl("blindfold").querySelector(".notes").insertAdjacentHTML("beforeend",
        '<div class="note reserve' + tone + '">Reserve check · ' + status + '<div class="reserve-detail">' + esc(e.detail) + '</div></div>');
    },
    source(e) { ref("b-source").textContent = e.text; },
    note(e) { note(e.side, e.text); },
    approval(e) {
      approvals[e.id] = e;
      approvalId = e.id;
      ref("ap-what").textContent = e.label + " for $" + (e.cents / 100).toFixed(2) + " (limit $" + (e.thresholdCents / 100).toFixed(2) + ")";
      const until = Date.now() + e.timeoutS * 1000;
      clearInterval(approvalTimer);
      const tick = () => { ref("ap-left").textContent = Math.max(0, Math.ceil((until - Date.now()) / 1000)) + " s"; };
      tick();
      approvalTimer = setInterval(tick, 500);
      ref("approval").hidden = false;
    },
    approval_done(e) {
      const a = approvals[e.id];
      if (approvalId === e.id) hideApproval();
      const what = a ? a.label + " ($" + (a.cents / 100).toFixed(2) + ")" : "purchase";
      note("blindfold", e.outcome === "approved" ? "Owner approved " + what
        : e.outcome === "denied" ? "Owner denied " + what + ", nothing paid" : "No owner answer: " + what + " denied, nothing paid");
    },
    done(e) { ref("act").textContent = e.ok ? "Done" : "Stopped"; },
  };

  /** Applies one event. A bad or unknown event is skipped, never fatal. */
  function apply(e) {
    if (!e || typeof e !== "object") return;
    try {
      const h = Object.hasOwn(handlers, e.type) ? handlers[e.type] : null;
      if (h) h(e, ctx);
      else if (typeof e.text === "string" && e.text) note(e.side === "exact" ? "exact" : "blindfold", e.text, "other");
    } catch (err) {
      console.warn("dashboard: could not render event", e, err);
    }
  }

  reset();
  return { reset, apply, interactive };
}
