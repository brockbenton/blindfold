// Records a demo run (pnpm demo or pnpm crowd) for the replay page: every dashboard event and every terminal line, with milliseconds since
// the start. Terminal lines are captured from stdout and stderr, so the recording has exactly what was printed.
// Each line is tagged with its act; an act's banner, printed just before its dashboard event, belongs to that act.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
/** A dashboard event as emitted: DashboardEvent (pnpm demo) or CrowdEvent (pnpm crowd), with its sequence number. */
export type RecordedEvent = { type: string; seq: number; [k: string]: unknown };

export const RECORDING_FORMAT = "blindfold-recording";

export interface Recording {
  format: typeof RECORDING_FORMAT;
  version: 1;
  recordedAt: string;
  /** Which demo: `pnpm demo` (single, the default for recordings without the field) or `pnpm crowd`. */
  demo?: "single" | "crowd";
  mode: "devnet" | "localnet" | null;
  /** Terminal width the narration was wrapped to. */
  columns: number;
  durationMs: number;
  events: { t: number; event: RecordedEvent }[];
  narration: { t: number; act: number; text: string }[];
}

export interface Recorder {
  event(e: { type: string; seq: number }): void;
  line(text: string): void;
  snapshot(): Recording;
  /** Writes the recording (atomically) to the file. */
  save(): void;
  /** Stops capturing stdout and stderr. */
  stop(): void;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const BAR = /^\s*=+\s*$/;

export function startRecorder(o: { file: string; demo?: "single" | "crowd"; now?: () => number; capture?: boolean; columns?: number }): Recorder {
  const now = o.now ?? (() => performance.now());
  const start = now();
  const t = () => Math.round(now() - start);
  const recordedAt = new Date().toISOString();
  const events: Recording["events"] = [];
  const demo = o.demo ?? "single";
  const narration: Recording["narration"] = [];
  let act = 0;
  let linesAtLastEvent = 0;

  const line = (text: string) => {
    for (const l of text.replace(ANSI, "").replace(/\r/g, "").split("\n")) narration.push({ t: t(), act, text: l.trimEnd() });
  };
  const event = (e: { type: string; seq: number }) => {
    events.push({ t: t(), event: e as RecordedEvent });
    if (e.type === "act") {
      // Lines printed since the previous event, from the act banner's first rule (and the blank line before it), go with this act.
      const run = narration.slice(linesAtLastEvent);
      let i = run.findIndex((l) => BAR.test(l.text));
      if (i > 0 && !run[i - 1].text) i--;
      const n = Number((e as { n?: unknown }).n);
      if (i >= 0) for (const l of run.slice(i)) l.act = n;
      act = n;
    }
    linesAtLastEvent = narration.length;
  };

  // Capture stdout and stderr, splitting writes into lines.
  const restores: (() => void)[] = [];
  if (o.capture !== false) {
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      let buf = "";
      stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        const i = buf.lastIndexOf("\n");
        if (i >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write;
      restores.push(() => {
        stream.write = orig as typeof stream.write;
        if (buf) line(buf);
      });
    }
  }

  const snapshot = (): Recording => ({
    format: RECORDING_FORMAT, version: 1, recordedAt, demo,
    mode: (events.find((e) => e.event.type === "setup")?.event as { mode?: "devnet" | "localnet" } | undefined)?.mode ?? null,
    columns: o.columns ?? Math.min(process.stdout.columns || 100, 100),
    durationMs: Math.max(events.at(-1)?.t ?? 0, narration.at(-1)?.t ?? 0),
    events, narration,
  });

  return {
    event, line, snapshot,
    save() {
      mkdirSync(dirname(o.file), { recursive: true });
      const tmp = `${o.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snapshot()) + "\n");
      renameSync(tmp, o.file);
    },
    stop() { for (const r of restores.splice(0)) r(); },
  };
}

/** Problems that make a recording unfit to publish; empty when it is fine. */
export function recordingProblems(rec: Recording, o: { mode?: "devnet" | "localnet"; demo?: "single" | "crowd" } = {}): string[] {
  const problems: string[] = [];
  if (rec.format !== RECORDING_FORMAT || rec.version !== 1) return ["not a version 1 Blindfold recording"];
  if (o.demo && (rec.demo ?? "single") !== o.demo) problems.push(`a ${rec.demo ?? "single"} recording, expected ${o.demo}`);
  if (o.mode && rec.mode !== o.mode) problems.push(`recorded on ${rec.mode ?? "an unknown cluster"}, expected ${o.mode}`);
  const done = rec.events.find((e) => e.event.type === "done")?.event as { ok?: boolean } | undefined;
  if (!done) problems.push("the run did not finish");
  else if (!done.ok) problems.push("the run stopped with an error");
  if (!rec.events.some((e) => e.event.type === "act")) problems.push("no acts recorded");
  return problems;
}
