// Replay timing and narration formatting, with no DOM access, so tests can import it.
// A recording (scripts/lib/recorder.ts) has dashboard events and terminal lines, each with `t` in milliseconds.

export const FORMAT = "blindfold-recording";

/** Checks a parsed recording's shape. Returns it, or throws with a reason. */
export function parseRecording(rec) {
  if (!rec || rec.format !== FORMAT) throw new Error("not a Blindfold recording");
  if (rec.version !== 1) throw new Error(`unsupported recording version ${rec.version}`);
  if (!Array.isArray(rec.events) || !Array.isArray(rec.narration)) throw new Error("recording has no events or narration");
  return rec;
}

/**
 * Merges events and narration into one timeline. Idle gaps longer than `maxGapMs` (chain confirmations, Copycat's
 * polling) are shortened to `maxGapMs`; order and everything else stay as recorded.
 * @returns {{ entries: Entry[], acts: Act[], duration: number }}
 *   Entry: { t, kind: "event", event } | { t, kind: "line", act, text }
 *   Act: { n, title, t } in order; jumping to an act seeks to `t`, which includes its terminal header.
 * With `reading` on, an act shorter than the time it takes to read its narration (about 400 words a minute,
 * 3 to 15 seconds) holds on its last line before the next act starts.
 */
export function buildTimeline(rec, { maxGapMs = 2500, reading = true } = {}) {
  const raw = [
    ...rec.events.map((e, i) => ({ t: num(e.t), o: i, kind: "event", event: e.event })),
    ...rec.narration.map((l, i) => ({ t: num(l.t), o: i, kind: "line", act: l.act, text: String(l.text ?? "") })),
  ];
  // Stable by time; at the same millisecond, a line before an event (narration prints before it emits).
  raw.sort((a, b) => a.t - b.t || (a.kind === b.kind ? a.o - b.o : a.kind === "line" ? -1 : 1));
  let prev = raw.length ? raw[0].t : 0;
  let now = 0;
  const entries = raw.map(({ t, o, ...rest }) => {
    now += Math.min(Math.max(0, t - prev), maxGapMs);
    prev = t;
    return { t: now, ...rest };
  });

  // Each act starts at its banner (the first line tagged with it) or its event, whichever comes first.
  const starts = [];
  entries.forEach((en, i) => {
    if (en.kind !== "event" || en.event?.type !== "act") return;
    const n = en.event.n;
    if (!Number.isSafeInteger(n)) return;
    const header = entries.findIndex((x) => x.kind === "line" && x.act === n);
    starts.push({ n, title: String(en.event.title ?? `Act ${n}`), i: header >= 0 ? Math.min(header, i) : i });
  });
  if (starts.length) starts[0].i = 0;
  let duration = entries.length ? entries[entries.length - 1].t : 0;

  if (reading) {
    starts.forEach((a, k) => {
      const words = entries.filter((x) => x.kind === "line" && x.act === a.n).reduce((w, x) => w + x.text.split(/\s+/).filter(Boolean).length, 0);
      const need = Math.min(15_000, Math.max(3000, words * 150));
      const next = starts[k + 1];
      const have = (next ? entries[next.i].t : duration) - entries[a.i].t;
      if (have >= need) return;
      if (next) for (let j = next.i; j < entries.length; j++) entries[j].t += need - have;
      duration += need - have;
    });
  }
  const acts = starts.map(({ n, title, i }) => ({ n, title, t: entries[i]?.t ?? 0 }));
  if (acts.length) acts[0].t = 0;
  return { entries, acts, duration };
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Number of entries at or before time `t` (entries sorted by t). */
export function indexAt(entries, t) {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the act playing at time `t`, or -1 before the first. */
export function actAt(acts, t) {
  let i = -1;
  for (let k = 0; k < acts.length; k++) if (acts[k].t <= t) i = k;
  return i;
}

/** A playback clock: position in recording milliseconds, with speed, pause and seek. `now` is injectable for tests. */
export class Player {
  constructor({ duration, now = () => performance.now() }) {
    this.duration = duration;
    this.now = now;
    this.speed = 1;
    this.playing = false;
    this.base = 0;
    this.anchor = now();
  }
  get position() {
    const p = this.playing ? this.base + (this.now() - this.anchor) * this.speed : this.base;
    return Math.min(Math.max(p, 0), this.duration);
  }
  get ended() { return this.position >= this.duration; }
  #rebase() { this.base = this.position; this.anchor = this.now(); }
  play() {
    if (this.ended) this.base = 0;
    this.anchor = this.now();
    this.playing = true;
  }
  pause() { this.#rebase(); this.playing = false; }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(t) { this.base = Math.min(Math.max(t, 0), this.duration); this.anchor = this.now(); }
  setSpeed(s) { this.#rebase(); this.speed = s; }
  /** Current position; stops at the end. */
  tick() {
    const p = this.position;
    if (this.playing && p >= this.duration) { this.base = this.duration; this.playing = false; }
    return p;
  }
}

// ---------------------------------------------------------------------------------------------- narration

const HIDDEN = [/Live dashboard:/, /\[Press Enter/, /^\s*Recording saved/];
const BAR = /^\s*=+\s*$/;

/**
 * Turns raw terminal lines (scripts/lib/narrate.ts output) into display lines: drops the act banner rules and
 * prompts, classifies by narrate's prefixes, and rejoins paragraphs that the terminal wrapped at `columns`.
 * @returns {{ cls: string, text: string, key?: string }[]}
 */
export function formatLines(texts, columns = 100) {
  const out = [];
  let inHeader = false, headerFirst = false, prevRaw = null;
  for (const raw of texts) {
    if (BAR.test(raw)) {
      inHeader = !inHeader;
      headerFirst = inHeader;
      prevRaw = null;
      continue;
    }
    if (HIDDEN.some((r) => r.test(raw))) { prevRaw = null; continue; }
    if (!raw.trim()) { if (out.length && out[out.length - 1].cls !== "gap" && !inHeader) out.push({ cls: "gap", text: "" }); prevRaw = null; continue; }
    const line = classify(raw, inHeader, headerFirst);
    headerFirst = false;
    const last = out[out.length - 1];
    // The terminal wrapped this paragraph if the next word did not fit on the previous line.
    const firstWord = raw.trimStart().split(/\s/)[0];
    if (prevRaw !== null && last && last.cls === line.cls && (line.cls === "say" || line.cls === "sub") &&
        indent(raw) === indent(prevRaw) && !/^https?:\/\//.test(firstWord) && !/^\s*https?:\/\//.test(prevRaw) && prevRaw.length + 1 + firstWord.length > columns) {
      last.text += " " + line.text;
    } else out.push(line);
    prevRaw = raw;
  }
  while (out.length && out[out.length - 1].cls === "gap") out.pop();
  while (out.length && out[0].cls === "gap") out.shift();
  return out;
}

const indent = (s) => s.length - s.trimStart().length;

function classify(raw, inHeader, headerFirst) {
  const text = raw.trim();
  if (inHeader) return { cls: headerFirst ? "title" : "sub", text };
  let m;
  if ((m = /^ {2}(ok|!!) {3}(.*)$/.exec(raw))) return { cls: m[1] === "ok" ? "ok" : "warn", text: m[2] };
  if ((m = /^ {2}(Copycat|Agent) +(.*)$/.exec(raw))) return { cls: m[1].toLowerCase(), text: m[2] };
  if (/^Demo stopped/.test(text)) return { cls: "err", text };
  if (/^Demo complete/.test(text)) return { cls: "ok", text };
  if (/^ {5}\S/.test(raw)) return { cls: "step", text };
  if ((m = /^ {3}(\S.*?) {2,}(\S.*)$/.exec(raw))) return { cls: "kv", key: m[1], text: m[2] };
  return { cls: "say", text };
}

/**
 * False for a link nobody else can open: an Explorer link whose custom RPC is this machine (a localnet run), or a
 * plain http:// URL (a local service). Everything else is public.
 */
export function isPublicUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const rpc = url.searchParams.get("customUrl");
    if (!rpc) return true;
    const host = new URL(rpc).hostname;
    return !(host === "localhost" || host === "[::1]" || /^127\./.test(host) || /^0\.0\.0\.0$/.test(host));
  } catch {
    return false;
  }
}

/** A copy of a dashboard event without links nobody else can open (`url` and the `links` map). */
export function stripLocalLinks(e) {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  if (typeof out.url === "string" && !isPublicUrl(out.url)) delete out.url;
  if (out.links && typeof out.links === "object") out.links = Object.fromEntries(Object.entries(out.links).filter(([, u]) => isPublicUrl(u)));
  return out;
}

/** A readable label for a URL: Solana Explorer links become "explorer tx 5Kq3…Zt9f". */
export function shortUrl(u) {
  try {
    const url = new URL(u);
    const m = /^\/(tx|address)\/([^/]+)/.exec(url.pathname);
    if (url.hostname === "explorer.solana.com" && m) return `explorer ${m[1]} ${m[2].slice(0, 4)}…${m[2].slice(-4)}`;
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return u;
  }
}

/** Formats an elapsed time in milliseconds as m:ss. */
export function clock(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
