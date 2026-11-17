// The static replay site: a landing page (home.html as index.html) that picks one of two replays, replay.html with
// the shared renderers, and one recording per demo. GitHub Pages serves it.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_DIR, SHARED_ASSETS } from "./dashboard.js";

export type Demo = "single" | "crowd";

/** Files the site loads, besides the recordings. */
export const REPLAY_ASSETS = [...SHARED_ASSETS, "replay.html", "replay.js", "replay-core.js"];
/** The published recordings, committed to the repository, by demo. */
export const PUBLISHED_RECORDINGS: Record<Demo, string> = {
  single: fileURLToPath(new URL("recording.json", DASHBOARD_DIR)),
  crowd: fileURLToPath(new URL("crowd-recording.json", DASHBOARD_DIR)),
};
/** Where the site serves each demo's recording, and the page that plays it. */
export const SITE_PATHS: Record<Demo, { recording: string; page: string }> = {
  single: { recording: "recording.json", page: "replay.html" },
  crowd: { recording: "crowd-recording.json", page: "replay.html?demo=crowd" },
};

/** Which demo a recording file is from (recordings made before the crowd replay have no `demo` and are single). */
export const demoOf = (file: string): Demo => ((JSON.parse(readFileSync(file, "utf8")) as { demo?: Demo }).demo === "crowd" ? "crowd" : "single");

export function buildSite(outDir: string, recordings: Partial<Record<Demo, string>> = {}): string[] {
  mkdirSync(outDir, { recursive: true });
  const dir = fileURLToPath(DASHBOARD_DIR);
  copyFileSync(join(dir, "home.html"), join(outDir, "index.html"));
  for (const f of REPLAY_ASSETS) copyFileSync(join(dir, f), join(outDir, f));
  const demos = Object.keys(SITE_PATHS) as Demo[];
  for (const d of demos) copyFileSync(recordings[d] ?? PUBLISHED_RECORDINGS[d], join(outDir, SITE_PATHS[d].recording));
  return ["index.html", ...REPLAY_ASSETS, ...demos.map((d) => SITE_PATHS[d].recording)];
}
