// The demo recorder, the replay page's timing and narration formatting, and the static site.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboard, type Dashboard } from "../lib/dashboard.js";
import { recordingProblems, startRecorder, type Recording } from "../lib/recorder.js";
import { buildSite } from "../lib/replaySite.js";
// @ts-expect-error plain browser module, no types
import { Player, actAt, buildTimeline, clock, formatLines, indexAt, isPublicUrl, parseRecording, shortUrl, stripLocalLinks } from "../dashboard/replay-core.js";

const BAR = "=".repeat(80);
const clockAt = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};
const tmp = () => mkdtempSync(join(tmpdir(), "bf-replay-test-"));

/** A short run shaped like demo.ts: banner, setup, two acts with banners, done. */
function fakeRun() {
  const c = clockAt(1000);
  const file = join(tmp(), "rec.json");
  const r = startRecorder({ file, now: c.now, capture: false, columns: 40 });
  let seq = 0;
  const emit = (e: any) => r.event({ ...e, seq: ++seq });
  r.line(`\n${BAR}\n  Copycat vs. your trading agent\n${BAR}`);
  r.line("     setting up");
  c.advance(4000);
  emit({ type: "setup", mode: "localnet", topic: "sol", prices: { whaleFlow: 5, depth: 10 }, exactWallet: "w", vault: "v", provider: "p", links: {} });
  emit({ type: "act", n: 0, title: "Ready" });
  c.advance(500);
  r.line(`\n\x1b[36m${BAR}\x1b[0m\n\x1b[1m  1. Standard x402\x1b[0m\n${BAR}`);
  emit({ type: "act", n: 1, title: "Paying with standard x402" });
  c.advance(100);
  r.line("  ok   call 1: paid 5 cents");
  c.advance(60_000); // a long chain wait
  emit({ type: "chain", side: "exact", kind: "direct_payment", text: "t", amountBase: "50000", from: "w", time: null, url: "https://explorer.solana.com/tx/abc?cluster=devnet", signature: "abc" });
  c.advance(200);
  r.line(`\n${BAR}\n  2. Fund\n${BAR}`);
  emit({ type: "act", n: 2, title: "Funding Blindfold tokens" });
  c.advance(300);
  emit({ type: "brand_new_event", whatever: 1 });
  emit({ type: "done", ok: true });
  return { r, file };
}

describe("recorder", () => {
  it("timestamps events and lines, strips colors, and gives each act its banner", () => {
    const { r } = fakeRun();
    const rec = r.snapshot();
    expect(rec).toMatchObject({ format: "blindfold-recording", version: 1, demo: "single", mode: "localnet", columns: 40, durationMs: 65_100 });
    expect(rec.events.map((e) => [e.t, e.event.type])).toEqual([
      [4000, "setup"], [4000, "act"], [4500, "act"], [64_600, "chain"], [64_800, "act"], [65_100, "brand_new_event"], [65_100, "done"],
    ]);
    const byAct = (n: number) => rec.narration.filter((l) => l.act === n).map((l) => l.text);
    expect(byAct(0)).toEqual(["", BAR, "  Copycat vs. your trading agent", BAR, "     setting up"]);
    expect(byAct(1)).toEqual(["", BAR, "  1. Standard x402", BAR, "  ok   call 1: paid 5 cents"]);
    expect(byAct(2)).toEqual(["", BAR, "  2. Fund", BAR]);
  });

  it("captures stdout and stderr line by line, including partial writes, until stopped", () => {
    const r = startRecorder({ file: join(tmp(), "x.json"), now: () => 0 });
    process.stdout.write("half ");
    process.stdout.write("a line\nnext\n");
    process.stderr.write("\x1b[31mDemo stopped: boom\x1b[0m\n");
    r.stop();
    process.stdout.write("after stop\n");
    expect(r.snapshot().narration.map((l) => l.text)).toEqual(["half a line", "next", "Demo stopped: boom"]);
  });

  it("saves valid JSON and flags runs that should not be published", () => {
    const { r, file } = fakeRun();
    r.save();
    const rec = JSON.parse(readFileSync(file, "utf8")) as Recording;
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(recordingProblems(rec)).toEqual([]);
    expect(recordingProblems(rec, { mode: "devnet" })).toEqual(["recorded on localnet, expected devnet"]);
    const failed = { ...rec, events: rec.events.map((e) => (e.event.type === "done" ? { ...e, event: { ...e.event, ok: false } } : e)) } as Recording;
    expect(recordingProblems(failed)).toEqual(["the run stopped with an error"]);
    expect(recordingProblems({ ...rec, events: [] })).toEqual(["the run did not finish", "no acts recorded"]);
    expect(recordingProblems(rec, { demo: "crowd" })).toEqual(["a single recording, expected crowd"]);
    const { demo: _, ...old } = rec; // recordings from before the crowd replay have no demo field
    expect(recordingProblems(old as Recording, { demo: "single" })).toEqual([]);
  });

  it("feeds the recorder from the live dashboard", async () => {
    const r = startRecorder({ file: join(tmp(), "x.json"), now: () => 0, capture: false });
    const d: Dashboard = await startDashboard({ port: 0, onEmit: r.event });
    try {
      d.emit({ type: "act", n: 1, title: "first" });
      expect(r.snapshot().events).toEqual([{ t: 0, event: { type: "act", n: 1, title: "first", seq: 1 } }]);
      expect(await (await fetch(`${d.url}/dashboard.js`)).text()).toContain("export function mountDashboard");
    } finally {
      await d.close();
    }
  });
});

describe("replay timeline", () => {
  it("only accepts integer act numbers from an external recording", () => {
    const rec = fakeRun().r.snapshot();
    rec.events.push({ t: rec.durationMs, event: { type: "act", n: "invalid", title: "invalid", seq: 999 } });
    expect(buildTimeline(rec).acts.map((a: { n: number }) => a.n)).toEqual([0, 1, 2]);
  });

  const timeline = () => buildTimeline(parseRecording(fakeRun().r.snapshot()), { maxGapMs: 2000, reading: false });

  it("rejects files that are not recordings", () => {
    expect(() => parseRecording({ format: "other" })).toThrow("not a Blindfold recording");
    expect(() => parseRecording({ format: "blindfold-recording", version: 2, events: [], narration: [] })).toThrow("version 2");
  });

  it("keeps order but shortens idle gaps", () => {
    const { entries, duration } = timeline();
    // 4 s setup wait and the 60 s chain wait each become 2 s; short gaps are kept.
    expect(duration).toBe(2000 + 500 + 100 + 2000 + 200 + 300);
    expect(entries.map((e: any) => e.t)).toEqual([...entries.map((e: any) => e.t)].sort((a, b) => a - b));
    // Narration printed before an event at the same millisecond stays before it.
    const i = entries.findIndex((e: any) => e.kind === "event" && e.event.type === "act" && e.event.n === 1);
    expect(entries[i - 1]).toMatchObject({ kind: "line", text: BAR });
  });

  it("starts each act at its banner, the first at zero", () => {
    const { acts } = timeline();
    expect(acts).toEqual([
      { n: 0, title: "Ready", t: 0 },
      { n: 1, title: "Paying with standard x402", t: 2500 },
      { n: 2, title: "Funding Blindfold tokens", t: 4800 },
    ]);
    expect(actAt(acts, 0)).toBe(0);
    expect(actAt(acts, 2499)).toBe(0);
    expect(actAt(acts, 2500)).toBe(1);
    expect(actAt(acts, 99_999)).toBe(2);
  });

  it("holds short acts long enough to read their narration", () => {
    const { acts, duration, entries } = buildTimeline(parseRecording(fakeRun().r.snapshot()), { maxGapMs: 2000 });
    // Act 0 already lasts 2.5 s of its 3 s minimum, so it gains 0.5 s; act 1 lasts 2.3 s, so +0.7 s; act 2 (0.3 s) gets +2.7 s at the end.
    expect(acts.map((a: any) => a.t)).toEqual([0, 3000, 6000]);
    expect(duration).toBe(9000);
    expect(entries[entries.length - 1].t).toBe(6300);
  });

  it("plays Act 5's score event, and recordings made before it still build", () => {
    const rec = fakeRun().r.snapshot();
    const side = { purchases: 3, transfers: 3, correct: 3, partial: 0, incorrect: 0, abstained: 0, complete: true, verdict: "attributed", summary: "s" };
    const score = { type: "score", text: "exact: 3/3", visible: "1 vault deposit", sides: { exact: side, blindfold: { ...side, correct: 0, transfers: 0, verdict: "not attributed" } }, seq: 99 };
    rec.events.splice(rec.events.length - 1, 0, { t: rec.durationMs, event: score });
    expect(recordingProblems(rec)).toEqual([]);
    const played = buildTimeline(parseRecording(rec)).entries.filter((e: any) => e.kind === "event" && e.event.type === "score");
    expect(played.map((e: any) => stripLocalLinks(e.event))).toEqual([score]);
    // The published recording predates the scoreboard (or carries it); either way it parses and has acts.
    const published = parseRecording(JSON.parse(readFileSync(new URL("../dashboard/recording.json", import.meta.url), "utf8")));
    expect(buildTimeline(published).acts.length).toBeGreaterThan(5);
  });

  it("finds how many entries are due at a time", () => {
    const entries = [{ t: 0 }, { t: 10 }, { t: 10 }, { t: 30 }];
    expect([-1, 0, 9, 10, 29, 30, 99].map((t) => indexAt(entries, t))).toEqual([0, 1, 1, 3, 3, 4, 4]);
  });
});

describe("Player", () => {
  it("plays at speed, pauses, seeks and stops at the end", () => {
    const c = clockAt();
    const p = new Player({ duration: 10_000, now: c.now });
    expect(p.tick()).toBe(0);
    p.play();
    c.advance(1000);
    expect(p.tick()).toBe(1000);
    p.setSpeed(4);
    c.advance(500);
    expect(p.tick()).toBe(3000);
    p.pause();
    c.advance(5000);
    expect(p.tick()).toBe(3000);
    p.seek(9000);
    p.play();
    c.advance(1000);
    expect(p.tick()).toBe(10_000);
    expect(p.playing).toBe(false);
    expect(p.ended).toBe(true);
    p.play(); // from the start again
    expect(p.tick()).toBe(0);
    p.seek(-5);
    expect(p.position).toBe(0);
  });
});

describe("narration formatting", () => {
  it("drops banner rules and prompts, classifies narrate's prefixes and rejoins wrapped paragraphs", () => {
    const lines = formatLines([
      "", BAR, "  6. Safety: an AI agent", "  An LLM agent researches SOL with its", "  tokens.", BAR,
      "   Each call is its own public Solana", "   transfer.",
      "   Short line.",
      "     starting the mint",
      "  ok   call 1: paid 5 cents",
      "  !!   created a key",
      "  Copycat  BUY SOL",
      "  Agent    buy_data -> REFUSED",
      "   Agent wallet   7xKX...gAsU  (a key the agent must hold)",
      "   tx 1       https://explorer.solana.com/tx/5Kq3abcZt9f?cluster=devnet",
      "", "",
      "   Live dashboard: http://localhost:5173",
      "   [Press Enter to continue]",
      "Demo stopped: boom",
    ], 40);
    expect(lines).toEqual([
      { cls: "title", text: "6. Safety: an AI agent" },
      { cls: "sub", text: "An LLM agent researches SOL with its tokens." },
      { cls: "say", text: "Each call is its own public Solana transfer." },
      { cls: "say", text: "Short line." },
      { cls: "step", text: "starting the mint" },
      { cls: "ok", text: "call 1: paid 5 cents" },
      { cls: "warn", text: "created a key" },
      { cls: "copycat", text: "BUY SOL" },
      { cls: "agent", text: "buy_data -> REFUSED" },
      { cls: "kv", key: "Agent wallet", text: "7xKX...gAsU  (a key the agent must hold)" },
      { cls: "kv", key: "tx 1", text: "https://explorer.solana.com/tx/5Kq3abcZt9f?cluster=devnet" },
      { cls: "gap", text: "" },
      { cls: "err", text: "Demo stopped: boom" },
    ]);
  });

  it("does not glue a URL to the lines around it", () => {
    const url = "https://explorer.solana.com/tx/" + "a".repeat(80);
    expect(formatLines(["   Owner deposit into the vault", `   ${url}`, "   Vault settlement batch", `   ${url}`], 40).map((l: any) => l.text))
      .toEqual(["Owner deposit into the vault", url, "Vault settlement batch", url]);
  });

  it("tells links others can open from links into a local validator", () => {
    const local = "https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899";
    expect(isPublicUrl("https://explorer.solana.com/tx/abc?cluster=devnet")).toBe(true);
    expect(isPublicUrl("https://explorer.solana.com/tx/abc?cluster=custom&customUrl=https%3A%2F%2Fexample.com")).toBe(true);
    expect(isPublicUrl(local)).toBe(false);
    expect(isPublicUrl("https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899")).toBe(false);
    expect(isPublicUrl("http://localhost:5173")).toBe(false);
    expect(isPublicUrl("not a url")).toBe(false);
    const e = { type: "chain", url: local, amountBase: "1", links: { vault: local, ok: "https://explorer.solana.com/address/x?cluster=devnet" } };
    expect(stripLocalLinks(e)).toEqual({ type: "chain", amountBase: "1", links: { ok: "https://explorer.solana.com/address/x?cluster=devnet" } });
    expect(e.url).toBe(local); // the original is untouched
    expect(stripLocalLinks({ type: "call", url: "https://explorer.solana.com/tx/a?cluster=devnet" }).url).toContain("cluster=devnet");
  });

  it("labels Explorer links and formats the clock", () => {
    expect(shortUrl("https://explorer.solana.com/tx/5Kq3abcdefZt9f?cluster=devnet")).toBe("explorer tx 5Kq3…Zt9f");
    expect(shortUrl("https://example.com/a/b")).toBe("example.com/a/b");
    expect(clock(0)).toBe("0:00");
    expect(clock(125_400)).toBe("2:05");
  });
});

describe("replay site", () => {
  it("contains the landing page, both replays, every file they load and one recording per demo", () => {
    const { r, file } = fakeRun();
    r.save();
    const out = tmp();
    const files = buildSite(out, { single: file });
    for (const f of files) expect(existsSync(join(out, f))).toBe(true);
    const read = (f: string) => readFileSync(join(out, f), "utf8");
    const refs = ["index.html", "replay.html", "replay.js", "crowd.html"].filter((f) => files.includes(f)).flatMap((f) =>
      [...(f.endsWith(".html") ? read(f).matchAll(/(?:href|src)="([^"]*)"/g) : []), ...read(f).matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]))
      .filter((u) => !/^[a-z]+:/.test(u) && u !== "./").map((u) => u.replace(/^\.\//, "").replace(/[?#].*$/, ""));
    expect(refs).toEqual(expect.arrayContaining(["replay.html", "dashboard.css", "crowd.css", "replay.js", "dashboard.js", "crowd-dashboard.js", "replay-core.js"]));
    for (const ref of refs) expect(files).toContain(ref);
    // The landing page links each card to its recording.
    for (const m of read("index.html").matchAll(/data-src="([^"]+)"/g)) expect(files).toContain(m[1]);
    expect(JSON.parse(read("recording.json")).recordedAt).toBe(r.snapshot().recordedAt);
    expect(JSON.parse(read("crowd-recording.json"))).toMatchObject({ format: "blindfold-recording", demo: "crowd" });
  });
});
