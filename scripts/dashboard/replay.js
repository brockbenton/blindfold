// Plays a recorded demo run through the live dashboard's renderer, with the terminal narration beside it. A
// recording of `pnpm crowd` plays through the crowd dashboard, any other through the main demo's.
// Query parameters: demo=crowd (play crowd-recording.json), src (recording URL, default recording.json),
// act (start at act n), speed (1, 2 or 4), autoplay=0 (start paused).
import { esc, mountDashboard } from "./dashboard.js";
import { mountCrowd } from "./crowd-dashboard.js";
import { Player, actAt, buildTimeline, clock, formatLines, indexAt, isPublicUrl, parseRecording, shortUrl, stripLocalLinks } from "./replay-core.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const root = $("dashboard");

let rec;
try {
  const res = await fetch(params.get("src") || (params.get("demo") === "crowd" ? "crowd-recording.json" : "recording.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rec = parseRecording(await res.json());
} catch (e) {
  const n = $("notice");
  n.textContent = `Could not load the recording (${e.message}).`;
  n.hidden = false;
  throw e;
}

const crowd = rec.demo === "crowd";
const dashboard = crowd ? mountCrowd(root) : mountDashboard(root, { interactive: false });
const { entries, acts, duration } = buildTimeline(rec);
const player = new Player({ duration });
const cluster = rec.mode === "devnet" ? "devnet" : rec.mode === "localnet" ? "local validator" : "recorded";
const date = rec.recordedAt ? new Date(rec.recordedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
document.title = crowd ? "Blindfold: the crowd demo" : rec.mode === "devnet" ? "Blindfold: a recorded devnet run" : "Blindfold replay";
$("meta").innerHTML = `${esc(cluster)} run${date ? ", " + esc(date) : ""} · <a href="https://github.com/brockbenton/blindfold" target="_blank" rel="noopener">source</a>`;

// ------------------------------------------------------------------------------------------- acts bar

const ends = acts.map((a, i) => (i + 1 < acts.length ? acts[i + 1].t : duration));
$("chapters").innerHTML = acts.map((a, i) =>
  `<button style="--w:${Math.max(1, ends[i] - a.t)}" title="${esc(a.title)}" aria-label="Act ${a.n}: ${esc(a.title)}"><i></i></button>`).join("");
const chapterButtons = [...$("chapters").children];
chapterButtons.forEach((b, i) => b.addEventListener("click", () => seek(acts[i].t)));

// ------------------------------------------------------------------------------------------- rendering

let applied = 0;
let termKey = "";
let shownLines = 0;

function render(pos) {
  // Dashboard: apply events up to pos; going back means replaying from the start without animations.
  const upto = indexAt(entries, pos);
  if (upto < applied) { dashboard.reset(); applied = 0; }
  const jump = upto - applied > 3;
  for (; applied < upto; applied++) if (entries[applied].kind === "event") dashboard.apply(stripLocalLinks(entries[applied].event));
  // After a jump, show the state at once: what is on screen now does not animate in.
  if (jump) {
    const all = [...root.querySelectorAll("*")];
    for (const el of all) { el.style.animation = "none"; el.style.transition = "none"; }
    void root.offsetHeight; // commit the new styles before transitions come back
    requestAnimationFrame(() => { for (const el of all) el.style.transition = ""; });
  }

  // Narration: the current act's lines so far.
  const ai = actAt(acts, pos);
  const act = acts[ai];
  const lines = act ? entries.slice(0, upto).filter((e) => e.kind === "line" && e.act === act.n) : [];
  const key = `${ai}:${lines.length}`;
  if (key !== termKey) {
    const term = $("term");
    const fresh = !termKey.startsWith(`${ai}:`);
    termKey = key;
    const formatted = formatLines(lines.map((l) => l.text), rec.columns || 100);
    term.innerHTML = formatted.map(line).join("");
    // Only lines that are new since the last render animate in.
    const still = fresh ? (jump ? formatted.length : 0) : shownLines;
    for (const el of [...term.children].slice(0, still)) el.style.animation = "none";
    shownLines = formatted.length;
    term.scrollTop = term.scrollHeight;
    $("term-act").textContent = act ? (ai === 0 ? "setup" : `act ${act.n} of ${acts[acts.length - 1].n}`) : "";
    chapterButtons.forEach((b, i) => b.classList.toggle("current", i === ai));
  }

  chapterButtons.forEach((b, i) => {
    const p = Math.min(1, Math.max(0, (pos - acts[i].t) / Math.max(1, ends[i] - acts[i].t)));
    b.firstChild.style.setProperty("--p", `${(p * 100).toFixed(2)}%`);
  });
  $("time").textContent = `${clock(pos)} / ${clock(duration)}`;
}

const URL_RE = /https:\/\/[^\s)]+/g; // http:// URLs in a recording are local services
/** Public URLs become links; Explorer links into a local validator stay text, since nobody else can open them. */
function linkify(s) {
  let out = "", last = 0;
  for (const m of s.matchAll(URL_RE)) {
    out += esc(s.slice(last, m.index)) + (isPublicUrl(m[0])
      ? `<a href="${esc(m[0])}" target="_blank" rel="noopener">${esc(shortUrl(m[0]))}</a>`
      : `<span class="local" title="On the local validator this run used; not public">${esc(shortUrl(m[0]))}</span>`);
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}

const TAGS = { ok: "ok", warn: "!!", observer: "Observer", agent: "Agent" };
function line(l) {
  if (l.cls === "gap") return '<div class="l gap"></div>';
  if (l.cls === "kv") return `<div class="l kv"><span class="key">${esc(l.key)}</span><span>${linkify(l.text)}</span></div>`;
  if (TAGS[l.cls]) return `<div class="l ${l.cls}"><span class="tag ${l.cls}">${TAGS[l.cls]}</span><span>${linkify(l.text)}</span></div>`;
  return `<div class="l ${l.cls}">${linkify(l.text)}</div>`;
}

// ------------------------------------------------------------------------------------------- controls

const ICONS = { play: "M4 2.5v11l9.5-5.5z", pause: "M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z", again: "M8 2.5a5.5 5.5 0 1 1-5.2 3.7l1.9.6A3.5 3.5 0 1 0 8 4.5V7L4 3.5 8 0z" };
function syncButtons() {
  const state = player.playing ? "pause" : player.ended ? "again" : "play";
  $("play-icon").setAttribute("d", ICONS[state]);
  $("play").setAttribute("aria-label", state === "pause" ? "Pause" : state === "again" ? "Replay from the start" : "Play");
  for (const b of document.querySelectorAll("[data-speed]")) b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === player.speed));
}
function seek(t) { player.seek(t); render(player.position); syncButtons(); }
function step(dir) {
  const pos = player.position;
  const ai = actAt(acts, pos);
  if (dir < 0) seek(ai > 0 && pos - acts[ai].t < 1500 ? acts[ai - 1].t : acts[Math.max(ai, 0)].t);
  else if (ai + 1 < acts.length) seek(acts[ai + 1].t);
}
function setSpeed(s) { player.setSpeed(s); syncButtons(); }

$("play").addEventListener("click", () => { player.toggle(); syncButtons(); });
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
for (const b of document.querySelectorAll("[data-speed]")) b.addEventListener("click", () => setSpeed(Number(b.dataset.speed)));
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); player.toggle(); syncButtons(); }
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
  else if (["1", "2", "4"].includes(e.key)) setSpeed(Number(e.key));
});

const startAct = acts.findIndex((a) => String(a.n) === params.get("act"));
if (startAct >= 0) player.seek(acts[startAct].t);
if ([1, 2, 4].includes(Number(params.get("speed")))) player.setSpeed(Number(params.get("speed")));
if (params.get("autoplay") !== "0") player.play();
syncButtons();

let wasPlaying = player.playing;
(function frame() {
  const pos = player.tick();
  render(pos);
  if (wasPlaying !== player.playing) { wasPlaying = player.playing; syncButtons(); }
  requestAnimationFrame(frame);
})();
