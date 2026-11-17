// The replay page: plays a recorded demo run through the dashboard (see docs/DEMO.md, "Recorded replay").
//
//   pnpm replay [file]             preview a recording (default: the published one) at http://localhost:5174
//   pnpm replay --site DIR [file]  write the static site that GitHub Pages serves
//   pnpm replay:publish [--calls N]
//                                  record a devnet run, check it, commit it as the published recording and push;
//                                  the Pages workflow redeploys when it reaches main
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveAsset } from "./lib/dashboard.js";
import { recordingProblems, type Recording } from "./lib/recorder.js";
import { PUBLISHED_RECORDING, REPLAY_ASSETS, buildSite } from "./lib/replaySite.js";

const argv = process.argv.slice(2);
const cwd = process.env.INIT_CWD ?? process.cwd(); // where the user ran pnpm
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] ?? "" : null;
};
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return r.stdout.trim();
};

if (argv[0] === "publish") {
  const dir = mkdtempSync(join(tmpdir(), "bf-recording-"));
  const file = join(dir, "recording.json");
  const demo = fileURLToPath(new URL("demo.ts", import.meta.url));
  const run = spawnSync(process.execPath, [...process.execArgv, demo, "--no-pause", "--record", file, ...argv.slice(1)], { stdio: "inherit" });
  if (run.status !== 0 || !existsSync(file)) {
    console.error(`\nThe demo did not finish, so nothing was published.${existsSync(file) ? ` Its recording: ${file}` : ""}`);
    process.exit(1);
  }
  const problems = recordingProblems(JSON.parse(readFileSync(file, "utf8")) as Recording, { mode: "devnet" });
  if (problems.length) {
    console.error(`\nNot publishing ${file}: ${problems.join("; ")}`);
    process.exit(1);
  }
  copyFileSync(file, PUBLISHED_RECORDING);
  const rel = relative(ROOT, PUBLISHED_RECORDING);
  git("add", rel);
  git("commit", "-m", "replay: new devnet recording", "--", rel);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  git("push", "-u", "origin", branch);
  console.log(`\nCommitted ${rel} and pushed ${branch}.`);
  console.log(branch === "main"
    ? "The pages workflow is redeploying the replay; it is live in a minute or two."
    : "The pages workflow redeploys the replay once this reaches main.");
} else {
  const site = flag("--site");
  const recording = argv[0] ? resolve(cwd, argv[0]) : PUBLISHED_RECORDING;
  if (!existsSync(recording)) throw new Error(`${recording} not found`);
  if (site !== null) {
    if (!site) throw new Error("--site needs a directory");
    const out = resolve(cwd, site);
    const files = buildSite(out, recording);
    console.log(`Wrote ${files.length} files to ${out}`);
  } else {
    const app = new Hono();
    serveAsset(app, "/", "replay.html");
    for (const f of REPLAY_ASSETS) serveAsset(app, `/${f}`, f);
    serveAsset(app, "/recording.json", pathToFileURL(recording));
    const port = Number(process.env.PORT ?? 5174);
    serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`Replaying ${relative(cwd, recording) || recording} at http://localhost:${port}  (Ctrl+C to stop)`));
  }
}
