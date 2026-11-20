// Glass Map: a replay of the recorded crowd run (crowd-recording.json, copied to the site root by `pnpm replay --site`)
// that draws what the agents bought next to what a public-chain observer could infer. Static: no server, no SSE.
// State is rebuilt from the recording's events up to the playback position, so any position always looks the same.
import { parseRecording, buildTimeline, Player, indexAt, actAt, clock, isPublicUrl } from "../../replay-core.js";

const RECORDING = "../../crowd-recording.json";
const NS = "http://www.w3.org/2000/svg";
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// Logical map coordinates (the SVG viewBox); CSS scales the whole map.
const W = 1200, H = 744;
const AG = { x: 24, w: 180 };
const BAND = { x: 400, w: 420, y: 52 };
const FEED = { x: 980, w: 196 };
const TOP = 104, BOTTOM = 404;
const VAULT = { x: 650, y: 494, w: 120, h: 52 };
const PAY_Y = VAULT.y + VAULT.h / 2;
const CHIP = { x: 414, y: 440, w: 180, h: 26, gap: 34 };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const short = (a) => String(a).slice(0, 4) + "…" + String(a).slice(-4);
const usdBase = (b) => "$" + (Number(b) / 1e6).toFixed(2);
const usdCents = (c) => "$" + (Number(c) / 100).toFixed(2);
const hhmmss = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "--:--:--");
const tokenOf = (label) => String(label).trim().split(/\s+/).at(-1);
const routeOfMemo = (memo) => String(memo).replace(/[-/]+/g, " ");
const sigOf = (url) => /\/tx\/([^/?#]+)/.exec(String(url ?? ""))?.[1];
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const ANSWER = { "NO SIGNAL": "no signal", "CANNOT ATTRIBUTE": "can't tell", PARTIAL: "amounts leak" };

function svg(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}
function label(parent, x, y, str, cls, attrs = {}) {
  const t = svg("text", { x, y, class: cls, ...attrs }, parent);
  t.textContent = str;
  return t;
}

async function load() {
  let rec;
  try {
    const res = await fetch(RECORDING, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
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
  $("gm-main").innerHTML = `<section class="panel error" role="alert"><h2>recording unavailable</h2><p>${esc(message)}</p></section>`;
  for (const b of document.querySelectorAll(".controls button")) b.disabled = true;
}

try {
  start(await load());
} catch (err) {
  fail(err.message);
}

function start({ rec, agents }) {
  const root = $("gm");
  const local = rec.mode === "localnet";
  $("gm-mode").textContent = "recorded crowd run · " + (local ? "local validator" : `public ${rec.mode ?? "network"}`);
  const timeline = buildTimeline(rec);
  const { entries, acts } = timeline;
  const player = new Player({ duration: timeline.duration });

  // ------------------------------------------------------------------------------------------------- layout
  const n = agents.length;
  const agentY = agents.map((_, i) => TOP + ((BOTTOM - TOP) / n) * (i + 0.5));
  const calls = rec.events.map((e) => e.event).filter((e) => e?.type === "call");
  const routeLabels = [...new Set(calls.map((e) => String(e.label)))].sort((a, b) => a.localeCompare(b));
  const tokens = [...new Set([...agents.map((a) => a.token), ...routeLabels.map(tokenOf)])].filter((t) => routeLabels.some((l) => tokenOf(l) === t));
  const groups = new Map();
  const routeY = new Map();
  let gy = TOP - 12;
  for (const tok of tokens) {
    groups.set(tok, gy);
    gy += 22;
    for (const l of routeLabels.filter((r) => tokenOf(r) === tok)) { routeY.set(l, gy); gy += 24; }
    gy += 10;
  }

  const map = $("gm-map");
  map.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const layer = (cls) => svg("g", { class: cls }, map);
  const lHeads = layer("heads");
  label(lHeads, AG.x, 34, "agents know", "col");
  label(lHeads, BAND.x + BAND.w / 2, 34, "what Solana sees", "col", { "text-anchor": "middle" });
  label(lHeads, FEED.x, 34, "TokenFeed", "col");
  const lPrivate = layer("under");
  svg("rect", { class: "band", x: BAND.x, y: BAND.y, width: BAND.w, height: H - 12 - BAND.y, rx: 16 }, map);
  const lEdges = layer("edges");
  const lNodes = layer("nodes");
  const lPulses = layer("pulses");

  // TokenFeed and its routes.
  svg("rect", { class: "node feed", x: FEED.x, y: BAND.y, width: FEED.w, height: PAY_Y + 40 - BAND.y, rx: 12 }, lNodes);
  label(lNodes, FEED.x + 12, BAND.y + 22, "TokenFeed · one provider", "feed-title");
  const routeEls = new Map();
  for (const [tok, y] of groups) label(lNodes, FEED.x + 12, y + 4, tok, "group");
  for (const [l, y] of routeY) {
    const g = svg("g", { class: "route idle" }, lNodes);
    label(g, FEED.x + 22, y + 4, l, "route-name");
    routeEls.set(l, label(g, FEED.x + FEED.w - 12, y + 4, "", "route-n", { "text-anchor": "end" }));
  }
  label(lNodes, FEED.x + 12, PAY_Y + 4, "batched payouts in", "route-name");

  // The vault, its payout edge, the observer's blindfold marker and the public ledger, all inside the band.
  svg("rect", { class: "node vault", x: VAULT.x, y: VAULT.y, width: VAULT.w, height: VAULT.h, rx: 10 }, lNodes);
  label(lNodes, VAULT.x + VAULT.w / 2, VAULT.y + 22, "Blindfold vault", "vault-title", { "text-anchor": "middle" });
  const vaultSub = label(lNodes, VAULT.x + VAULT.w / 2, VAULT.y + 40, "", "sub", { "text-anchor": "middle" });
  const payout = svg("path", { class: "edge payout off", d: `M ${VAULT.x + VAULT.w} ${PAY_Y} L ${FEED.x} ${PAY_Y}` }, lEdges);
  const payoutLabel = label(lEdges, (VAULT.x + VAULT.w + FEED.x) / 2, PAY_Y - 8, "", "elabel payout-label", { "text-anchor": "middle" });
  const payoutSub = label(lEdges, (VAULT.x + VAULT.w + FEED.x) / 2, PAY_Y + 16, "", "elabel sub", { "text-anchor": "middle" });
  const marker = label(lEdges, VAULT.x + VAULT.w / 2, VAULT.y - 20, "", "marker", { "text-anchor": "middle" });
  const lChips = svg("g", { class: "chips" }, lEdges);
  const forcedEdge = svg("path", { class: "edge infer forced off" }, lEdges);
  const FORCED_Y = 596; // the forced-owner inference runs below the chips, so it never crosses another depositor
  const forcedLabel = label(lEdges, 700, FORCED_Y + 20, "", "elabel forced-label", { "text-anchor": "middle" });
  const ledgerTop = 640;
  label(lNodes, BAND.x + 14, ledgerTop, "public ledger · latest", "col small");
  const lLedger = svg("g", { class: "band-ledger" }, lNodes);

  // Agents.
  const agentEls = agents.map((a, i) => {
    const cy = agentY[i];
    const g = svg("g", { class: "agent", "data-agent": i, tabindex: 0, role: "button",
      "aria-label": `Agent ${a.name}, researching ${a.token}, wallet ${a.wallet}, owner ${a.owner}. Focus this agent.` }, lNodes);
    svg("title", {}, g).textContent = `Agent ${a.name} · ${a.token}\nwallet ${a.wallet}\nowner ${a.owner}`;
    svg("rect", { class: "node", x: AG.x, y: cy - 38, width: AG.w, height: 76, rx: 12 }, g);
    label(g, AG.x + 14, cy - 12, `Agent ${a.name} · ${a.token}`, "agent-name");
    label(g, AG.x + 14, cy + 6, short(a.wallet), "sub");
    return { g, stats: label(g, AG.x + 14, cy + 24, "", "stats"), http: label(lEdges, BAND.x - 6, cy + 44, "HTTP token · no transaction", "http off", { "text-anchor": "end", "data-agent": i }) };
  });

  // One edge per side/agent/route pair seen anywhere in the recording, hidden until its first call.
  const edges = new Map();
  const ax = AG.x + AG.w;
  for (const e of calls) {
    const key = `${e.side}|${e.agent}|${e.label}`;
    if (edges.has(key) || !routeY.has(String(e.label)) || !(e.agent in agentY)) continue;
    const cy = agentY[e.agent], ry = routeY.get(String(e.label));
    if (e.side === "exact") {
      const path = svg("path", { class: "edge exact off", "data-agent": e.agent, d: `M ${ax} ${cy - 18} C ${ax + 260} ${cy - 18}, ${FEED.x - 260} ${ry}, ${FEED.x} ${ry}` }, lEdges);
      edges.set(key, { side: "exact", path, text: label(lEdges, 0, 0, "", "elabel exact-label off", { "text-anchor": "end", "data-agent": e.agent }) });
    } else {
      const k = [...edges.values()].filter((x) => x.side === "blindfold" && x.agent === e.agent).length;
      const by = cy + 6 + k * 16;
      const path = svg("path", { class: "edge blind off", "data-agent": e.agent, d: `M ${ax} ${cy + 4} C ${ax + 100} ${cy + 4}, ${BAND.x - 100} ${by}, ${BAND.x - 4} ${by}` }, lEdges);
      const hidden = svg("path", { class: "edge private off", "data-agent": e.agent, d: `M ${BAND.x - 4} ${by} C ${BAND.x + 200} ${by}, ${FEED.x - 220} ${ry + 5}, ${FEED.x} ${ry + 5}` }, lPrivate);
      edges.set(key, { side: "blindfold", agent: e.agent, path, hidden, text: label(lEdges, BAND.x - 10, by - 4, "", "elabel blind-label off", { "text-anchor": "end", "data-agent": e.agent }) });
    }
  }
  // The observer's exact-side inference: payer wallet -> the token its memos name.
  const infer = agents.map((_, i) => ({
    path: svg("path", { class: "edge infer off", "data-agent": i }, lEdges),
    text: label(lEdges, 0, 0, "", "elabel infer-label off", { "data-agent": i }),
  }));

  // ------------------------------------------------------------------------------------------------- state
  let state, applied, pulses = [], focus = -1, lens = "both", lastScene = -2;

  function reset() {
    state = {
      act: -1,
      edges: new Map(), // key -> { side, agent, route, n, cents, public }
      agentCalls: agents.map(() => 0),
      agentCents: agents.map(() => 0),
      tokens: null,
      owners: [], // { addr, deposits: [{ round, base }], forced: false }
      payouts: [], // { round, base }
      exact: null,
      verdicts: new Map(), // round -> latest vault event
      pub: [], // public chain rows for the band ledger
      rows: [], // activity rows
    };
    applied = 0;
    for (const p of pulses) p.el.remove();
    pulses = [];
  }

  const agentByWallet = (w) => agents.findIndex((a) => a.wallet === w);

  function apply(e, t, animate) {
    switch (e?.type) {
      case "act":
        if (Number.isSafeInteger(e.n)) state.act = e.n;
        break;
      case "call": {
        const key = `${e.side}|${e.agent}|${e.label}`;
        const s = state.edges.get(key) ?? { side: e.side, agent: e.agent, route: String(e.label), n: 0, cents: 0, public: false };
        s.n++;
        s.cents += Number(e.cents) || 0;
        state.edges.set(key, s);
        if (e.agent in state.agentCalls) { state.agentCalls[e.agent]++; state.agentCents[e.agent] += Number(e.cents) || 0; }
        state.rows.push({ t, side: e.side, agent: e.agent, who: agents[e.agent] ? `Agent ${agents[e.agent].name}` : "?", what: String(e.label),
          amount: usdCents(e.cents), vis: e.side === "exact" ? "onchain" : "offchain" });
        if (animate) pulse(edges.get(key));
        break;
      }
      case "chain": {
        const sig = sigOf(e.url);
        const link = e.url && isPublicUrl(e.url) ? e.url : null;
        if (e.kind === "direct_payment") {
          const i = agentByWallet(e.from);
          const s = state.edges.get(`exact|${i}|${routeOfMemo(e.memo)}`);
          if (s) s.public = true;
          state.pub.push({ time: e.time, text: `${short(e.from)} → feed · ${e.memo}`, amount: usdBase(e.amountBase), agent: i });
          state.rows.push({ t, side: "exact", agent: i, who: i >= 0 ? `Agent ${agents[i].name}` : short(e.from), what: `direct payment ${short(e.from)} → feed · ${e.memo}`,
            amount: usdBase(e.amountBase), vis: "onchain", sig, link });
        } else if (e.kind === "vault_deposit") {
          let o = state.owners.find((x) => x.addr === e.from);
          if (!o) state.owners.push((o = { addr: e.from, deposits: [], forced: false }));
          o.deposits.push({ round: e.round, base: e.amountBase });
          state.pub.push({ time: e.time, text: `deposit ${short(e.from)} → vault`, amount: usdBase(e.amountBase), from: e.from, round: e.round });
          state.rows.push({ t, side: "blindfold", agent: "vault", who: "vault", what: `deposit ${short(e.from)} → vault · round ${e.round}`,
            amount: usdBase(e.amountBase), vis: "onchain", sig, link, from: e.from, round: e.round });
        } else if (e.kind === "vault_payout") {
          state.payouts.push({ round: e.round, base: e.amountBase });
          state.pub.push({ time: e.time, text: "vault → feed · batched", amount: usdBase(e.amountBase) });
          state.rows.push({ t, side: "blindfold", agent: "vault", who: "vault", what: `payout vault → TokenFeed · round ${e.round}`,
            amount: usdBase(e.amountBase), vis: "batched", sig, link });
          if (animate && !reduced.matches) pulseAlong(payout, false);
        }
        break;
      }
      case "exact":
        if (Array.isArray(e.signals)) state.exact = e;
        break;
      case "vault":
        state.verdicts.set(e.round, e);
        for (const addr of e.forced ?? []) {
          const o = state.owners.find((x) => x.addr === addr);
          if (o) o.forced = true;
          for (const r of [...state.rows, ...state.pub]) if (r.from === addr && r.round === e.round) r.forced = true;
        }
        break;
      case "tokens":
        if (Array.isArray(e.cents)) state.tokens = e.cents;
        break;
    }
  }

  /** Applies every event up to playback position `pos`; going backwards rebuilds from the start. */
  function sync(pos) {
    const idx = indexAt(entries, pos);
    const scene = actAt(acts, pos);
    if (idx === applied && scene === lastScene) return;
    if (idx < applied) reset();
    const animate = player.playing && idx - applied <= 4 && !reduced.matches;
    for (let i = applied; i < idx; i++) if (entries[i].kind === "event") apply(entries[i].event, entries[i].t, animate);
    applied = idx;
    lastScene = scene;
    render(scene);
  }

  // ------------------------------------------------------------------------------------------------- pulses
  function pulse(edge) {
    if (edge) pulseAlong(edge.path, edge.side === "blindfold");
  }
  function pulseAlong(path, fade) {
    const el = svg("circle", { r: 5, class: "pulse " + (fade ? "blind" : path.classList.contains("payout") ? "payout" : "exact") }, lPulses);
    pulses.push({ el, path, len: 0, start: performance.now(), dur: 1100 / player.speed, fade });
  }
  function animatePulses(now) {
    pulses = pulses.filter((p) => {
      const f = (now - p.start) / p.dur;
      if (f >= 1) { p.el.remove(); return false; }
      p.len ||= p.path.getTotalLength(); // after render: the path may have been hidden when the pulse was queued
      const pt = p.path.getPointAtLength(f * p.len);
      p.el.setAttribute("cx", pt.x);
      p.el.setAttribute("cy", pt.y);
      p.el.style.opacity = p.fade ? String(Math.max(0, 1 - Math.max(0, f - 0.6) / 0.4)) : "1";
      return true;
    });
  }

  // ------------------------------------------------------------------------------------------------- render
  const weight = (n) => Math.min(n, 6);
  function setOff(el, off) { el.classList.toggle("off", off); }

  function render(scene) {
    // Edges.
    for (const [key, e] of edges) {
      const s = state.edges.get(key);
      const on = !!s;
      for (const el of [e.path, e.hidden, e.text]) if (el) setOff(el, !on);
      if (!on) continue;
      e.path.style.strokeWidth = String(1.2 + weight(s.n) * 0.5);
      e.path.style.strokeOpacity = String(0.35 + weight(s.n) * 0.1);
      if (e.hidden) e.hidden.style.strokeWidth = e.path.style.strokeWidth;
      e.path.classList.toggle("public", s.public);
      e.text.textContent = `${plural(s.n, "read")} · ${usdCents(s.cents)}`;
      if (e.side === "exact") {
        const pt = e.path.getPointAtLength(e.path.getTotalLength() * 0.86);
        e.text.setAttribute("x", pt.x - 6);
        e.text.setAttribute("y", pt.y - 5);
      }
    }
    for (const [l, el] of routeEls) {
      const reads = [...state.edges.values()].filter((s) => s.route === l).reduce((a, s) => a + s.n, 0);
      el.textContent = reads ? String(reads) : "";
      el.parentNode.classList.toggle("idle", !reads);
    }

    // Agents.
    agents.forEach((a, i) => {
      const bal = state.tokens && Number.isFinite(state.tokens[i]) ? ` · token ${usdCents(state.tokens[i])}` : "";
      agentEls[i].stats.textContent = `${plural(state.agentCalls[i], "call")}${bal}`;
      setOff(agentEls[i].http, ![...state.edges.values()].some((s) => s.side === "blindfold" && s.agent === i));
    });

    // Observer inference on the exact side.
    const signals = state.exact?.signals ?? [];
    infer.forEach((x, i) => {
      const s = signals.find((g) => agentByWallet(g.payer) === i && g.token);
      const hy = s && groups.get(s.token);
      setOff(x.path, hy === undefined);
      setOff(x.text, hy === undefined);
      if (hy === undefined) return;
      const cy = agentY[i];
      x.path.setAttribute("d", `M ${ax} ${cy - 30} C ${ax + 220} ${cy - 90}, ${FEED.x - 240} ${hy - 50}, ${FEED.x} ${hy}`);
      const pt = x.path.getPointAtLength(x.path.getTotalLength() * 0.3);
      x.text.setAttribute("x", pt.x);
      x.text.setAttribute("y", pt.y - 12);
      x.text.textContent = `${short(s.payer)} → ${s.token}`;
    });

    // Vault side.
    const deposits = state.owners.reduce((a, o) => a + o.deposits.length, 0);
    vaultSub.textContent = deposits ? plural(deposits, "deposit") : "no deposits yet";
    lChips.replaceChildren();
    state.owners.forEach((o, k) => {
      const y = CHIP.y + k * CHIP.gap, cy = y + CHIP.h / 2;
      const g = svg("g", { class: "chip" + (o.forced ? " forced" : ""), "data-agent": "vault" }, lChips);
      svg("title", {}, g).textContent = `depositor ${o.addr}`;
      svg("path", { class: "edge deposit", d: `M ${CHIP.x + CHIP.w} ${cy} C ${CHIP.x + CHIP.w + 30} ${cy}, ${VAULT.x - 30} ${PAY_Y}, ${VAULT.x} ${PAY_Y}` }, g);
      svg("rect", { class: "node chip-box", x: CHIP.x, y, width: CHIP.w, height: CHIP.h, rx: 6 }, g);
      label(g, CHIP.x + 8, cy + 4, short(o.addr), "chip-addr");
      label(g, CHIP.x + CHIP.w - 8, cy + 4, o.deposits.map((d) => usdBase(d.base)).join(" · "), "chip-amt", { "text-anchor": "end" });
    });
    setOff(payout, !state.payouts.length);
    payoutLabel.textContent = state.payouts.length ? `${plural(state.payouts.length, "payout")} · ${usdBase(state.payouts.reduce((a, p) => a + Number(p.base), 0))}` : "";
    payoutSub.textContent = state.payouts.length ? "batched · payer unknown" : "";
    const r1 = state.verdicts.get(1);
    marker.textContent = deposits || state.payouts.length ? "? → ?" + (r1 ? " · " + (ANSWER[r1.action] ?? r1.action.toLowerCase()) : "") : "";

    const forced = state.owners.findIndex((o) => o.forced);
    setOff(forcedEdge, forced < 0);
    if (forced >= 0) {
      const cy = CHIP.y + forced * CHIP.gap + CHIP.h / 2;
      forcedEdge.setAttribute("d", `M ${CHIP.x} ${cy} C ${CHIP.x - 12} ${cy}, ${CHIP.x - 12} ${FORCED_Y}, ${CHIP.x + 40} ${FORCED_Y} L ${FEED.x - 80} ${FORCED_Y} C ${FEED.x - 30} ${FORCED_Y}, ${FEED.x - 30} ${PAY_Y + 24}, ${FEED.x} ${PAY_Y + 24}`);
      const owner = agents.findIndex((a) => a.owner === state.owners[forced].addr);
      forcedLabel.textContent = `${short(state.owners[forced].addr)}${owner >= 0 ? ` (Agent ${agents[owner].name}'s owner)` : ""} must have paid the feed · token unknown`;
    } else forcedLabel.textContent = "";

    lLedger.replaceChildren();
    state.pub.slice(-5).reverse().forEach((r, k) => {
      const g = svg("g", { class: "ledger-row" + (r.forced ? " forced" : ""), "data-agent": r.agent ?? "vault" }, lLedger);
      const y = ledgerTop + 20 + k * 17;
      label(g, BAND.x + 14, y, hhmmss(r.time), "sub");
      label(g, BAND.x + 84, y, r.text, "ledger-text");
      label(g, BAND.x + BAND.w - 14, y, r.amount, "ledger-amt", { "text-anchor": "end" });
    });

    renderPanels();
    renderReport();
    renderScenes(scene);
    applyFocus();
  }

  function renderPanels() {
    const truth = [...state.edges.values()].sort((a, b) => a.agent - b.agent || (a.side === b.side ? a.route.localeCompare(b.route) : a.side === "exact" ? -1 : 1));
    $("gm-truth").innerHTML = truth.length
      ? `<table><thead><tr><th>agent</th><th>token</th><th>route</th><th>rail</th><th class="num">reads</th><th class="num">spend</th></tr></thead><tbody>${truth.map((s) =>
          `<tr data-agent="${s.agent}" class="${s.side}"><td>Agent ${esc(agents[s.agent]?.name ?? "?")}</td><td>${esc(agents[s.agent]?.token ?? "?")}</td><td>${esc(s.route)}</td><td>${s.side === "exact" ? "standard x402" : "Blindfold"}</td><td class="num">${s.n}</td><td class="num">${usdCents(s.cents)}</td></tr>`).join("")}</tbody></table>`
      : '<p class="empty">no purchases yet</p>';

    const signals = [...(state.exact?.signals ?? [])].sort((a, b) => agentByWallet(a.payer) - agentByWallet(b.payer));
    const named = signals.filter((s) => s.token).length;
    const exactHtml = signals.length
      ? `<div class="verdict-line alarm"><b>${named} of ${n} named</b>${state.exact.final ? " · every wallet tied to its token" : ""}</div><ul class="obs">${signals.map((s) => {
          const i = agentByWallet(s.payer);
          return `<li data-agent="${i}"><span class="addr">${esc(short(s.payer))}</span>${i >= 0 ? ` <span class="muted">(Agent ${esc(agents[i].name)})</span>` : ""} → ${esc(s.token || "token unknown")} · ${esc(s.action)} · ${plural(Number(s.calls), "read")}</li>`;
        }).join("")}</ul>`
      : '<p class="empty">no direct payments yet</p>';

    const rounds = [...state.verdicts.keys()].sort((a, b) => a - b);
    const blindHtml = rounds.length
      ? rounds.map((r) => {
          const v = state.verdicts.get(r);
          const tone = v.action === "PARTIAL" ? "warn" : ANSWER[v.action] ? "calm" : "alarm";
          let forced = "";
          for (const addr of v.forced ?? []) {
            const i = agents.findIndex((a) => a.owner === addr);
            forced += `<p class="forced-line" data-agent="vault"><span class="addr">${esc(short(addr))}</span>${i >= 0 ? ` = Agent ${esc(agents[i].name)}'s owner <span class="muted">(matched from the run's setup)</span>` : ""} · must have paid the feed · token unknown</p>`;
          }
          return `<div class="round"><div class="verdict-line ${tone}">round ${Number(r)} · <b>${esc(v.action)}</b> · ${esc(ANSWER[v.action] ?? "")}</div><p class="reason">${esc(v.reason ?? "")}</p>${forced}</div>`;
        }).join("")
      : state.owners.length || state.payouts.length || [...state.edges.values()].some((s) => s.side === "blindfold")
        ? '<div class="verdict-line">? → ? <span class="muted">· watching the vault</span></div>'
        : '<p class="empty">no Blindfold activity yet</p>';

    $("gm-observer").innerHTML = `<h3>standard x402</h3>${exactHtml}<h3>Blindfold</h3>${blindHtml}`;

    const rows = state.rows.slice().reverse();
    $("gm-ledger").innerHTML = rows.length
      ? `<table><thead><tr><th>time</th><th>side</th><th>who</th><th>route / chain kind</th><th class="num">amount</th><th>visibility</th><th>signature</th></tr></thead><tbody>${rows.map((r) => {
          const sig = r.sig ? (r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(short(r.sig))}</a>` : esc(short(r.sig))) : "";
          return `<tr data-agent="${esc(r.agent)}" class="${r.side} ${r.vis}${r.forced ? " forced" : ""}"><td>${clock(r.t)}</td><td>${r.side}</td><td>${esc(r.who)}</td><td>${esc(r.what)}</td><td class="num">${esc(r.amount)}</td><td><span class="vis">${r.vis}</span></td><td class="muted">${sig}</td></tr>`;
        }).join("")}</tbody></table>`
      : '<p class="empty">nothing has happened yet</p>';
  }

  function renderReport() {
    const el = $("gm-report");
    el.hidden = !acts.length || state.act < acts[acts.length - 1].n;
    if (el.hidden) return;
    const signals = state.exact?.signals ?? [];
    const named = signals.filter((s) => s.token).length;
    const rounds = [...state.verdicts.keys()].sort((a, b) => a - b).map((r) => {
      const v = state.verdicts.get(r);
      return `round ${Number(r)} <b>${esc(v.action)}${v.action === "PARTIAL" ? " / amount fingerprint" : ""}</b>`;
    });
    el.innerHTML = `<h2>the observer's report</h2><table><tbody>
      <tr class="exact"><th>standard x402</th><td><b>${named}/${n} named</b> · every wallet tied to its token</td></tr>
      <tr class="blindfold"><th>Blindfold</th><td>${rounds.join(" · ") || "no verdict"}</td></tr></tbody></table>
      <p class="foot">${local ? "Recorded on a local validator (localnet); its Explorer links are not public." : `Recorded on ${esc(rec.mode)}.`}
      The map shows the crowd's ground truth next to what a public observer can read. It is not evidence that Blindfold hides deposits
      or provider payouts: both are public, which is why they are on the map.</p>`;
  }

  const sceneList = $("gm-scenes");
  sceneList.innerHTML = acts.map((a, k) => `<li><button type="button" data-scene="${k}">${a.n} · ${esc(a.title)}</button></li>`).join("");
  function renderScenes(scene) {
    for (const b of sceneList.querySelectorAll("button")) {
      if (Number(b.dataset.scene) === scene) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    }
  }

  function applyFocus() {
    root.classList.toggle("focused", focus >= 0);
    for (const el of root.querySelectorAll("[data-agent]")) el.classList.toggle("dim", focus >= 0 && el.dataset.agent !== String(focus));
    const note = $("gm-focus");
    note.hidden = focus < 0;
    if (focus >= 0) {
      const a = agents[focus];
      note.textContent = `Agent ${a.name} · ${a.token} · ${plural(state.agentCalls[focus], "call")} · ${usdCents(state.agentCents[focus])} · click the map to clear`;
    }
  }

  // ------------------------------------------------------------------------------------------------- controls
  const playBtn = $("gm-play");
  const seek = (t) => { player.seek(t); sync(player.position); };
  const toggle = () => { player.toggle(); };
  const sceneStep = (d) => {
    const k = actAt(acts, player.position);
    const to = acts[Math.min(Math.max(k + d, 0), acts.length - 1)];
    if (to) seek(to.t);
  };

  playBtn.addEventListener("click", toggle);
  $("gm-restart").addEventListener("click", () => { reset(); lastScene = -2; seek(0); });
  $("gm-prev").addEventListener("click", () => sceneStep(-1));
  $("gm-next").addEventListener("click", () => sceneStep(1));
  sceneList.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-scene]");
    if (b) seek(acts[Number(b.dataset.scene)].t);
  });
  $("gm-speed").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-speed]");
    if (!b) return;
    player.setSpeed(Number(b.dataset.speed));
    for (const x of $("gm-speed").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  });
  $("gm-lens").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lens]");
    if (!b) return;
    lens = b.dataset.lens;
    root.dataset.lens = lens;
    for (const x of $("gm-lens").querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
  });
  root.dataset.lens = lens;

  const setFocus = (i) => { focus = focus === i ? -1 : i; applyFocus(); };
  agentEls.forEach(({ g }, i) => {
    g.addEventListener("click", (e) => { e.stopPropagation(); setFocus(i); });
    g.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      setFocus(i);
    });
  });
  map.addEventListener("click", () => { if (focus >= 0) { focus = -1; applyFocus(); } });

  // A mouse click leaves focus on the button; drop it so Space keeps toggling playback instead of re-clicking it.
  root.addEventListener("click", (e) => { if (e.detail > 0) e.target.closest("button")?.blur(); });
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === " " && !e.target.closest?.("button, a, [role=button]")) { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); sceneStep(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); sceneStep(1); }
  });

  let shown = "";
  function frame(now) {
    const pos = player.tick();
    sync(pos);
    const text = `${clock(pos)} / ${clock(timeline.duration)}`;
    const btn = player.playing ? "pause" : "play";
    if (text + btn !== shown) {
      shown = text + btn;
      $("gm-clock").textContent = text;
      playBtn.textContent = btn;
    }
    animatePulses(now);
    requestAnimationFrame(frame);
  }

  reset();
  sync(0);
  requestAnimationFrame(frame);
}
