// Glass Map: the crowd run (crowd-recording.json, at the site root; pnpm replay serves a live run there) shown stage by
// stage as a ledger: what each agent did privately, what reaches the chain, and what a public observer sees and
// concludes. Each stage shows its settled end state; state is rebuilt from the recording's events, so a stage always
// looks the same however you reach it.
import { parseRecording, buildTimeline, indexAt, clock } from "../../replay-core.js";

const RECORDING = "../../crowd-recording.json";
// Acts left out of the stage list. Their events still apply in order; nothing past the last stage is shown.
const SKIP = new Set([2, 5, 6]);
// Acts about Blindfold only: their stages hide the agents' x402 purchases and transfers, which earlier stages showed.
const BLINDFOLD_ONLY = new Set([3, 4]);
// Deck-style headline and short tab name per act; the recorded act title stays as the caption.
const COPY = {
  0: ["Three agents. One data feed.", "The crowd"],
  1: ["Every call is public.", "Standard x402"],
  3: ["Same research. Nothing on chain.", "Blindfold"],
  4: ["One payout. No names.", "One payout"],
};

const $ = (id) => document.getElementById(id);
const short = (a) => String(a).slice(0, 4) + "…" + String(a).slice(-4);
const usdBase = (b) => "$" + (Number(b) / 1e6).toFixed(2);
const usdCents = (c) => "$" + (Number(c) / 100).toFixed(2);
const sigOf = (url) => /\/tx\/([^/?#]+)/.exec(String(url ?? ""))?.[1];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const sum = (xs, f) => xs.reduce((s, x) => s + Number(f(x)), 0);

/** Creates an element; children are nodes or text, and empty ones ("", null, false) are skipped. */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) n.setAttribute(k, String(v));
  n.append(...children.flat().filter((c) => c !== "" && c !== null && c !== undefined && c !== false));
  return n;
}
// Every colored label carries its meaning as text too, in three words: public (on chain), private (off chain) and
// guess (the observer's inference).
const VIS = { onchain: ["public", "public"], offchain: ["private", "private"], batched: ["public", "public"], inferred: ["inferred", "guess"] };
const TONE = { "NO SIGNAL": "private", "CANNOT ATTRIBUTE": "private", PARTIAL: "inferred" };
const tag = (kind, text = kind) => el("span", { class: `tag t-${kind}` }, text);
const visTag = (vis) => tag(...VIS[vis]);
// The observer sees which token a wallet researches, not which way it will trade.
const conclusion = (s) => (!s.token ? "no token in the memo → following the wallet"
  : /^BUY\b/.test(s.action) ? `researches ${s.token} → expect a ${s.token} trade` : `bought ${s.token} data once → watching`);
// Every transaction links to its Explorer page, localnet ones included: those resolve only while that validator runs.
const txLink = (x) => (x.sig ? (x.link ? el("a", { class: "tx", href: x.link, target: "_blank", rel: "noopener", title: x.sig }, `tx ${x.sig.slice(0, 4)}`) : `tx ${x.sig.slice(0, 4)}`) : "");
const txs = (xs) => el("span", { class: "txs" }, xs.map(txLink));

async function load() {
  let rec;
  try {
    let res = await fetch(RECORDING, { cache: "no-cache" });
    // pnpm replay answers 503 while its live crowd run is still going; wait for it rather than show an older run.
    while (res.status === 503) {
      $("gm-scene").textContent = `Waiting for the live crowd run · ${await res.text()}`;
      await new Promise((r) => setTimeout(r, 2000));
      res = await fetch(RECORDING, { cache: "no-cache" });
    }
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status} ${res.statusText}`.trim());
    rec = parseRecording(await res.json());
  } catch (err) {
    throw new Error(`Could not load the crowd recording ${RECORDING}: ${err.message}`);
  }
  if (rec.demo !== "crowd") throw new Error(`${RECORDING} is not a crowd recording (demo: ${rec.demo ?? "single"})`);
  const setup = rec.events.find((e) => e?.event?.type === "setup")?.event;
  if (!Array.isArray(setup?.agents) || !setup.agents.length) throw new Error(`${RECORDING} has no setup event with agents`);
  return { rec, agents: setup.agents };
}

function fail(message) {
  $("gm-main").replaceChildren(el("section", { class: "error", role: "alert" }, el("h2", {}, "recording unavailable"), el("p", {}, message)));
  for (const b of document.querySelectorAll(".stages button")) b.disabled = true;
}

try {
  start(await load());
} catch (err) {
  fail(err.message);
}

function start({ rec, agents }) {
  const root = $("gm");
  const { entries, acts, duration } = buildTimeline(rec);
  if (!acts.length) throw new Error(`${RECORDING} has no acts`);

  // Act k ends at the entry before the next act event: a round's last balance and its verdict are logged while the
  // next act's banner is printing, and still belong to act k.
  const endOf = (k) => {
    if (k === acts.length - 1) return duration;
    const i = entries.findIndex((x) => x.kind === "event" && x.event?.type === "act" && x.event.n === acts[k + 1].n);
    return Math.max(acts[k].t, i > 0 ? entries[i - 1].t : acts[k + 1].t - 1);
  };
  // The stages a presenter steps through, numbered from 0 by position; each shows its act's end state.
  const stages = acts.flatMap((a, k) => (SKIP.has(a.n) && k > 0 ? [] : [{
    title: a.title, end: endOf(k), x402: !BLINDFOLD_ONLY.has(a.n), headline: COPY[a.n]?.[0] ?? a.title, short: COPY[a.n]?.[1] ?? a.title,
  }]));
  const last = stages.length - 1;

  // ------------------------------------------------------------------------------------------------- layout
  // One grid row per agent between the column heads and the vault row; the columns share rows, so nothing crosses.
  const map = $("gm-map");
  map.style.setProperty("--rows", agents.length + 2);
  const [truthCol, railCol, pubCol] = map.querySelectorAll(".col");
  const lanes = agents.map((a, i) => {
    const btn = el("button", { type: "button", class: "agent", "aria-pressed": "false" },
      el("span", { class: "agent-name" }, `Agent ${a.name}`), el("span", { class: "agent-token" }, `researching ${a.token}`));
    const body = el("div", { class: "lane-body" });
    const rail = el("div", { class: "cell rail", "data-agent": i });
    const pub = el("div", { class: "cell pub", "data-agent": i });
    truthCol.append(el("div", { class: "cell lane", "data-agent": i }, btn, body));
    railCol.append(rail);
    pubCol.append(pub);
    btn.addEventListener("click", (e) => { e.stopPropagation(); setFocus(i); });
    return { btn, body, rail, pub };
  });
  const vaultRail = el("div", { class: "cell rail", "data-agent": "vault" });
  const vaultCell = el("div", { class: "cell pub vault", "data-agent": "vault" });
  truthCol.append(el("div", { class: "cell lane vault-lane", "data-agent": "vault" }, el("p", { class: "agent-name" }, "Blindfold vault"), el("p", { class: "muted" }, "shared by every owner")));
  railCol.append(vaultRail);
  pubCol.append(vaultCell);

  // ------------------------------------------------------------------------------------------------- state
  let state, applied, stage = 0, focus = -1;

  function reset() {
    state = {
      routes: agents.map(() => new Map()), // `${side}|${label}` -> { side, label, n, cents }
      payments: [], // direct payments: { agent, from, memo, base, sig, link }
      deposits: [], // { from, round, base, forced, sig, link }
      payouts: [], // { round, base, sig, link }
      exact: null, // latest observer reading of the direct payments
      verdicts: new Map(), // round -> latest vault event
      trace: [], // every event as a row: { t, rail, agent, who, what, amount, vis, sig, link, from, round }
    };
    applied = 0;
  }

  const agentByWallet = (w) => agents.findIndex((a) => a.wallet === w);
  const agentByOwner = (w) => agents.findIndex((a) => a.owner === w);
  const who = (i, addr) => (i >= 0 ? `Agent ${agents[i].name}` : short(addr));

  function apply(e, t) {
    switch (e?.type) {
      case "call": {
        if (!agents[e.agent]) break;
        const label = String(e.label);
        const routes = state.routes[e.agent];
        const key = `${e.side}|${label}`;
        const r = routes.get(key) ?? { side: e.side, label, n: 0, cents: 0 };
        r.n++;
        r.cents += Number(e.cents) || 0;
        routes.set(key, r);
        state.trace.push({ t, rail: e.side === "exact" ? "x402" : "Blindfold", agent: e.agent, who: who(e.agent), amount: usdCents(e.cents),
          what: `${label} · ${e.side === "exact" ? "x402 purchase, paid by public transfer" : "Blindfold purchase, token over HTTP, no transfer"}`, vis: e.side === "exact" ? "onchain" : "offchain" });
        break;
      }
      case "chain": {
        const tx = { sig: sigOf(e.url), link: e.url || null };
        const row = { t, amount: usdBase(e.amountBase), ...tx };
        if (e.kind === "direct_payment") {
          const a = agentByWallet(e.from);
          state.payments.push({ agent: a, from: e.from, memo: String(e.memo), base: e.amountBase, ...tx });
          state.trace.push({ ...row, rail: "x402", agent: a, who: who(a, e.from), what: `transfer ${short(e.from)} → TokenFeed, memo ${e.memo}`, vis: "onchain" });
        } else if (e.kind === "vault_deposit") {
          state.deposits.push({ from: e.from, round: e.round, base: e.amountBase, forced: false, ...tx });
          state.trace.push({ ...row, rail: "vault", agent: agentByOwner(e.from), who: short(e.from), what: `deposit ${short(e.from)} → vault (round ${e.round})`,
            vis: "onchain", from: e.from, round: e.round });
        } else if (e.kind === "vault_payout") {
          state.payouts.push({ round: e.round, base: e.amountBase, ...tx });
          state.trace.push({ ...row, rail: "vault", agent: "vault", who: "vault", what: `vault → TokenFeed, one transfer (round ${e.round})`, vis: "batched" });
        }
        break;
      }
      case "exact":
        if (Array.isArray(e.signals)) state.exact = e;
        break;
      case "vault":
        state.verdicts.set(e.round, e);
        for (const addr of e.forced ?? []) {
          for (const d of state.deposits) if (d.from === addr && d.round === e.round) d.forced = true;
          for (const r of state.trace) if (r.from === addr && r.round === e.round) r.vis = "inferred";
        }
        break;
    }
  }

  /** Applies every event up to position `pos`; going backwards rebuilds from the start. */
  function sync(pos) {
    const idx = indexAt(entries, pos);
    if (idx < applied) reset();
    for (let i = applied; i < idx; i++) if (entries[i].kind === "event") apply(entries[i].event, entries[i].t);
    applied = Math.max(applied, idx);
  }

  // ------------------------------------------------------------------------------------------------- render
  function render() {
    renderLanes();
    renderVault();
    renderResult();
    renderTrace();
    renderStage();
    applyFocus();
  }

  const none = (text) => el("p", { class: "none" }, text);
  const block = (title, items) => (items.length ? el("div", { class: "block" }, el("h3", {}, title), el("ul", { class: "list" }, items)) : "");
  // "2 × $0.05 = $0.10": the same arithmetic on both sides, so the private and public totals visibly match.
  const times = (n, cents) => `${n} × ${usdCents(cents / n)} = ${usdCents(cents)}`;
  const cellText = (r) => (r ? times(r.n, r.cents) : "—");

  function renderLanes() {
    agents.forEach((a, i) => {
      const { btn, body, rail, pub } = lanes[i];
      // Rails shown: x402 only on stages that show it, and only rails with a purchase so far (no empty "—" column).
      const sides = (stages[stage].x402 ? ["exact", "blindfold"] : ["blindfold"])
        .filter((s) => agents.some((_, j) => [...state.routes[j].values()].some((r) => r.side === s)));
      const routes = [...state.routes[i].values()].filter((r) => sides.includes(r.side));
      const n = sum(routes, (r) => r.n);
      btn.setAttribute("aria-label", `Focus Agent ${a.name}, researching ${a.token}: ${plural(n, "purchase")}`);

      // Private: one row per data product, one column per payment rail.
      const products = [...new Set(routes.map((r) => r.label))].sort();
      const of = (side, label) => state.routes[i].get(`${side}|${label}`);
      const total = (side) => routes.filter((r) => r.side === side);
      // Tokens left = what the owner deposited minus what the agent spent with Blindfold (both from the events).
      const depositedCents = sum(state.deposits.filter((d) => d.from === a.owner), (d) => d.base) / 1e4;
      const spentCents = sum(total("blindfold"), (r) => r.cents);
      body.replaceChildren(
        products.length
          ? el("table", { class: "spend" },
            el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "purchases"),
              sides.map((s) => el("th", { scope: "col", class: "num" }, s === "exact" ? "x402" : "Blindfold", el("span", { class: "unit" }, "count × price"))))),
            el("tbody", {}, products.map((p) => el("tr", {}, el("th", { scope: "row" }, p.replace(new RegExp(`\\s+${a.token}$`), "")),
              sides.map((s) => el("td", { class: "num" }, cellText(of(s, p))))))),
            el("tfoot", {}, el("tr", {}, el("th", { scope: "row" }, "total"),
              ...sides.map((s) => el("td", { class: "num" }, total(s).length ? `${sum(total(s), (r) => r.n)} for ${usdCents(sum(total(s), (r) => r.cents))}` : "—")))))
          : none("no purchases yet"),
        depositedCents > 0 ? el("p", { class: "balance" }, "Blindfold tokens left ", el("b", {}, usdCents(depositedCents - spentCents)), " ",
          el("span", { class: "muted" }, `(${usdCents(depositedCents)} deposited − ${usdCents(spentCents)} spent)`)) : "");

      // The boundary: an x402 purchase crosses it as a transfer; a Blindfold purchase stops at it.
      const exact = total("exact").length > 0, blind = total("blindfold").length > 0;
      rail.classList.toggle("is-blank", !exact && !blind);
      // Each arrow crosses the boundary (x402: a public transfer) or stops at it (Blindfold: a token over HTTP).
      const arrow = (kind, name, note) => el("div", { class: `cross r-${kind}` }, el("p", { class: "cross-name" }, name),
        el("span", { class: "cross-line", "aria-hidden": "true" }), el("p", { class: "cross-note" }, note));
      rail.replaceChildren(exact || blind ? el("span", { class: "who" }, `Agent ${a.name}`) : "",
        exact ? arrow("exact", "x402", "crosses: public transfer") : "",
        blind ? arrow("blindfold", "Blindfold", "stops: token over HTTP") : "");

      // Public: what the chain shows for this lane, then what the observer makes of it.
      const pays = stages[stage].x402 ? state.payments.filter((p) => p.agent === i) : [];
      const deps = state.deposits.filter((d) => d.from === a.owner);
      const signal = stages[stage].x402 ? state.exact?.signals.find((s) => s.payer === a.wallet) : null;
      const byMemo = [...new Set(pays.map((p) => p.memo))].sort().map((memo) => pays.filter((p) => p.memo === memo));
      const sees = [
        ...byMemo.map((ps) => el("li", {}, el("span", { class: "addr" }, short(a.wallet)), ` → TokenFeed, memo ${ps[0].memo}: `,
          el("b", {}, times(ps.length, sum(ps, (p) => p.base) / 1e4)), txs(ps))),
        pays.length ? el("li", { class: "sum" }, `total: ${plural(pays.length, "transfer")} = ${usdBase(sum(pays, (p) => p.base))}`) : "",
        ...deps.map((d) => el("li", {}, el("span", { class: "addr" }, short(d.from)), ` → vault · deposit ${usdBase(d.base)} (round ${d.round}) `, txs([d]))),
      ].filter(Boolean);
      const concludes = [
        signal ? el("li", { class: "c-guess" }, tag("inferred", "guess"), " ", el("span", { class: "addr" }, short(signal.payer)), ` ${conclusion(signal)}`) : "",
        ...deps.map((d) => (d.forced
          ? el("li", { class: "c-guess" }, tag("inferred", "guess"), " ", el("span", { class: "addr" }, short(d.from)), " paid TokenFeed; token unknown")
          : el("li", { class: "c-safe" }, `${short(d.from)}'s deposit: can't be tied to any agent or purchase`))),
      ].filter(Boolean);
      pub.replaceChildren(el("span", { class: "who" }, `Agent ${a.name}`), sees.length ? block("Sees", sees) : none("nothing on chain yet"), block("Concludes", concludes));
    });
  }

  function renderVault() {
    const paidBase = sum(state.payouts, (p) => p.base) + (stages[stage].x402 ? sum(state.payments, (p) => p.base) : 0);
    $("gm-feed").replaceChildren(el("b", {}, "TokenFeed"), ` has received ${usdBase(paidBase)} on chain`, stages[stage].x402 ? "" : " from the vault");

    vaultRail.classList.toggle("is-blank", !state.payouts.length);
    vaultRail.replaceChildren(state.payouts.length ? el("div", { class: "cross r-batched" }, el("p", { class: "cross-name" }, "Vault"),
      el("span", { class: "cross-line", "aria-hidden": "true" }), el("p", { class: "cross-note" }, "crosses: one payout for all")) : "");

    const orphans = state.deposits.filter((d) => agentByOwner(d.from) < 0);
    const depositedBase = sum(state.deposits, (d) => d.base), paidOutBase = sum(state.payouts, (p) => p.base);
    const sees = [
      state.deposits.length ? el("li", {}, `${plural(state.deposits.length, "deposit")} into the vault · ${usdBase(depositedBase)} total`,
        state.payouts.length ? ` · ${usdBase(depositedBase - paidOutBase)} still in the vault` : "") : "",
      ...orphans.map((d) => el("li", {}, el("span", { class: "addr" }, short(d.from)), ` → vault · deposit ${usdBase(d.base)} (round ${d.round}) `, txs([d]))),
      ...state.payouts.map((p) => el("li", {}, `vault → TokenFeed · ${usdBase(p.base)} in one transfer (round ${p.round}) `, txs([p]))),
    ].filter(Boolean);
    const concludes = state.payouts.map((p) => el("li", { class: "c-safe" }, `round ${p.round} payout: could be any mix of the deposits; who paid for what is unknown`));
    vaultCell.replaceChildren(sees.length ? block("Sees", sees) : none("no vault activity yet"), block("Concludes", concludes));
  }

  // Rebuilt only when it changes: the region is live, and screen readers announce every rebuild.
  let resultKey = "";
  function renderResult() {
    const all = agents.flatMap((_, i) => [...state.routes[i].values()]);
    const signals = state.exact?.signals ?? [];
    const named = signals.filter((s) => s.token).length;
    const round = Math.max(-Infinity, ...state.verdicts.keys());
    const v = state.verdicts.get(round);
    const blind = all.some((r) => r.side === "blindfold") || state.deposits.length > 0;
    const forced = v ? (v.forced ?? []).length : 0;
    const key = JSON.stringify([signals.length, named, blind, v?.action, v?.reason, round]);
    if (key === resultKey) return;
    resultKey = key;
    const stat = (kind, num, label, extra) => el("div", { class: `stat stat-${kind}` }, el("p", { class: "stat-num" }, num), el("p", { class: "stat-label" }, label), extra ?? "");
    const out = [];
    if (signals.length) out.push(stat("public", `${named} of ${agents.length}`, "agents identified, with their tokens · x402"));
    if (v) {
      out.push(stat(TONE[v.action] ?? "public", `${forced} of ${agents.length}`, "agents identified · Blindfold",
        el("p", { class: "stat-sub" }, el("span", { class: `verdict-chip v-${TONE[v.action] ?? "public"}` }, v.action), " ", v.reason ?? "")));
    } else if (blind) out.push(stat("private", "—", "Blindfold · no conclusion yet"));
    $("gm-result").replaceChildren(...out);
  }

  function renderTrace() {
    const rows = state.trace;
    $("gm-trace-sum").textContent = rows.length ? `· ${plural(rows.length, "event")}` : "· nothing has happened yet";
    $("gm-trace").replaceChildren(rows.length
      ? el("table", {}, el("thead", {}, el("tr", {}, ["time", "rail", "who", "event", "amount", "visibility", "tx"].map((h) => el("th", { scope: "col", class: h === "amount" ? "num" : null }, h)))),
        el("tbody", {}, rows.map((r) => el("tr", { "data-agent": r.agent },
          el("td", { class: "muted" }, clock(r.t)), el("td", {}, r.rail), el("td", {}, r.who), el("td", {}, r.what), el("td", { class: "num" }, r.amount ?? ""),
          el("td", {}, visTag(r.vis)), el("td", {}, txLink(r))))))
      : none("nothing has happened yet"));
  }

  const sceneList = $("gm-scenes");
  sceneList.replaceChildren(...stages.map((s, k) => el("li", {}, el("button", { type: "button", "data-stage": k }, el("span", { class: "step-n" }, String(k)), s.short))));
  function renderStage() {
    $("gm-scene").textContent = stages[stage].headline;
    $("gm-caption").textContent = `Stage ${stage} of ${last} · ${stages[stage].title}`;
    for (const b of sceneList.querySelectorAll("button")) {
      if (Number(b.dataset.stage) === stage) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    }
    $("gm-prev").disabled = stage === 0;
    $("gm-next").disabled = stage === last;
  }

  function applyFocus() {
    for (const n of root.querySelectorAll("[data-agent]")) n.classList.toggle("dim", focus >= 0 && n.dataset.agent !== String(focus));
    lanes.forEach(({ btn }, i) => btn.setAttribute("aria-pressed", String(focus === i)));
  }
  function setFocus(i) {
    focus = focus === i ? -1 : i;
    applyFocus();
  }

  // ------------------------------------------------------------------------------------------------- stages
  /** Shows stage k's settled end state. */
  function showStage(k) {
    stage = Math.min(Math.max(k, 0), last);
    sync(stages[stage].end);
    render();
  }

  $("gm-prev").addEventListener("click", () => showStage(stage - 1));
  $("gm-next").addEventListener("click", () => showStage(stage + 1));
  sceneList.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-stage]");
    if (b) showStage(Number(b.dataset.stage));
  });
  map.addEventListener("click", (e) => {
    if (focus >= 0 && !e.target.closest("a")) { focus = -1; applyFocus(); }
  });
  const CONTROL = "a, summary, input, select, textarea";
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.(CONTROL)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); showStage(stage - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); showStage(stage + 1); }
  });

  reset();
  showStage(0);
}
