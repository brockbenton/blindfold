// The static replay site: replay.html as index.html, the shared renderer and one recording. GitHub Pages serves it.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DASHBOARD_DIR, SHARED_ASSETS } from "./dashboard.js";

/** Files the replay page loads, besides recording.json. */
export const REPLAY_ASSETS = [...SHARED_ASSETS, "replay.js", "replay-core.js"];
/** The published recording, committed to the repository. */
export const PUBLISHED_RECORDING = fileURLToPath(new URL("recording.json", DASHBOARD_DIR));

export function buildSite(outDir: string, recording = PUBLISHED_RECORDING): string[] {
  mkdirSync(outDir, { recursive: true });
  const dir = fileURLToPath(DASHBOARD_DIR);
  copyFileSync(join(dir, "replay.html"), join(outDir, "index.html"));
  for (const f of REPLAY_ASSETS) copyFileSync(join(dir, f), join(outDir, f));
  copyFileSync(recording, join(outDir, "recording.json"));
  return ["index.html", ...REPLAY_ASSETS, "recording.json"];
}
