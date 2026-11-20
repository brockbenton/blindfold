// The replay site: plays recorded runs of pnpm demo and pnpm crowd through their dashboards (see docs/DEMO.md,
// "Recorded replay"). A landing page picks one.
//
//   pnpm replay [file]             preview the site at http://localhost:5174, with `file` in place of the published
//                                  recording of its demo; scripts/vault-history is at /vault/ as on GitHub Pages
//                                  (Glass Map: http://localhost:5174/vault/glass-map/). Without a crowd `file`, it
//                                  also runs pnpm crowd in the background (validator on LOCALNET_PORT, default
//                                  8999) and serves that run as the crowd recording, so the Glass Map's Explorer
//                                  links open its transactions while the preview runs. --recorded skips that.
//   pnpm replay --site DIR [file]  write the static site that GitHub Pages serves
//   pnpm replay:publish [--main] [--calls N]
//                                  record a devnet run of pnpm demo, check it, commit it as the published recording
//                                  and push; the Pages workflow redeploys when it reaches main
//   pnpm replay:publish --crowd [--agents N]
//                                  the same for pnpm crowd, which runs on a local validator
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { serveAsset } from "./lib/dashboard.js";
import { recordingProblems, type Recording } from "./lib/recorder.js";
import { PUBLISHED_RECORDINGS, REPLAY_ASSETS, SITE_PATHS, buildSite, demoOf, type Demo } from "./lib/replaySite.js";

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
  const args = argv.slice(1);
  const crowd = args.includes("--crowd");
  const pushMain = args.includes("--main");
  const demo: Demo = crowd ? "crowd" : "single";
  // The crowd demo runs on a local validator only; the single-agent demo is published from devnet.
  const mode = crowd ? "localnet" : "devnet";
  const dir = mkdtempSync(join(tmpdir(), "bf-recording-"));
  const file = join(dir, "recording.json");
  const script = fileURLToPath(new URL(crowd ? "crowd.ts" : "demo.ts", import.meta.url));
  const run = spawnSync(process.execPath, [...process.execArgv, script, "--no-pause", "--record", file, ...args.filter((a) => a !== "--crowd" && a !== "--main")], { stdio: "inherit" });
  if (run.status !== 0 || !existsSync(file)) {
    console.error(`\nThe demo did not finish, so nothing was published.${existsSync(file) ? ` Its recording: ${file}` : ""}`);
    process.exit(1);
  }
  const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
  const problems = recordingProblems(recording, { mode, demo });
  if (!crowd && !recording.events.some(({ event }) => event.type === "reserve" && event.ok === true && event.verified === true && event.url)) {
    problems.push("no successful reserve check linked to the onchain issuance log");
  }
  if (problems.length) {
    console.error(`\nNot publishing ${file}: ${problems.join("; ")}`);
    process.exit(1);
  }
  copyFileSync(file, PUBLISHED_RECORDINGS[demo]);
  const rel = relative(ROOT, PUBLISHED_RECORDINGS[demo]);
  git("add", rel);
  git("commit", "-m", `replay: new ${crowd ? "crowd" : "devnet"} recording`, "--", rel);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (pushMain) git("push", "origin", "HEAD:main");
  else git("push", "-u", "origin", branch);
  const publishedBranch = pushMain ? "main" : branch;
  console.log(`\nCommitted ${rel} and pushed ${publishedBranch}.`);
  console.log(publishedBranch === "main"
    ? "The pages workflow is redeploying the replay; it is live in a minute or two."
    : "The pages workflow redeploys the replay once this reaches main.");
} else {
  const site = flag("--site");
  const recordedOnly = argv.includes("--recorded");
  if (recordedOnly) argv.splice(argv.indexOf("--recorded"), 1);
  const recordings = { ...PUBLISHED_RECORDINGS };
  let shown: Demo | null = null;
  if (argv[0]) {
    const file = resolve(cwd, argv[0]);
    if (!existsSync(file)) throw new Error(`${file} not found`);
    shown = demoOf(file);
    recordings[shown] = file;
  }
  for (const f of Object.values(recordings)) if (!existsSync(f)) throw new Error(`${f} not found`);
  if (site !== null) {
    if (!site) throw new Error("--site needs a directory");
    const out = resolve(cwd, site);
    const files = buildSite(out, recordings);
    console.log(`Wrote ${files.length} files to ${out}`);
  } else {
    const app = new Hono();
    serveAsset(app, "/", "home.html");
    for (const f of REPLAY_ASSETS) serveAsset(app, `/${f}`, f);
    const live = shown !== "crowd" && !recordedOnly ? startLiveCrowd() : null;
    for (const d of Object.keys(SITE_PATHS) as Demo[]) {
      if (d === "crowd" && live) app.get(`/${SITE_PATHS[d].recording}`, live.serve);
      else serveAsset(app, `/${SITE_PATHS[d].recording}`, pathToFileURL(recordings[d]));
    }
    // The Pages workflow copies scripts/vault-history to /vault/. Directories need the trailing slash, as on Pages,
    // because their pages load relative assets.
    app.get("/vault", (c) => c.redirect("/vault/"));
    app.get("/vault/:dir{[^/.]+}", (c) => c.redirect(`${c.req.path}/`));
    app.get("/vault/*", serveStatic({ root: fileURLToPath(new URL("vault-history", import.meta.url)), rewriteRequestPath: (p) => p.slice("/vault".length) }));
    const port = Number(process.env.PORT ?? 5174);
    const url = `http://localhost:${port}/${shown ? SITE_PATHS[shown].page : ""}`;
    serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
      console.log(`${shown ? `Replaying ${relative(cwd, recordings[shown]) || recordings[shown]}` : "Replays"} at ${url}  (Ctrl+C to stop)`);
      console.log(`Glass Map at http://localhost:${port}/vault/glass-map/`);
    });
  }
}

/**
 * Runs pnpm crowd headless with --hold: it saves its recording when the run is done and keeps its validator up, so the
 * recording's Explorer links resolve. Until the file exists, the recording route answers 503 (the Glass Map waits).
 */
function startLiveCrowd() {
  const dir = mkdtempSync(join(tmpdir(), "bf-live-crowd-"));
  const file = join(dir, "crowd-recording.json");
  const log = join(dir, "crowd.log");
  const out = openSync(log, "w");
  const port = process.env.LOCALNET_PORT ?? "8999";
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("crowd.ts", import.meta.url)), "--no-pause", "--hold", "--record", file], {
    stdio: ["ignore", out, out],
    env: { ...process.env, LOCALNET_PORT: port, CROWD_DASHBOARD_PORT: process.env.CROWD_DASHBOARD_PORT ?? "5190" },
  });
  let exit: number | null = null;
  console.log(`Live crowd run for the Glass Map: starting (about a minute), validator at http://127.0.0.1:${port}, log ${log}`);
  const ready = setInterval(() => {
    if (existsSync(file)) console.log("Live crowd run ready: reload the Glass Map.");
    if (existsSync(file) || exit !== null) clearInterval(ready);
  }, 1000);
  child.on("exit", (code) => {
    exit = code ?? 1;
    if (exit !== 0) console.error(`Live crowd run stopped (exit ${exit}); see ${log}`);
  });
  // Stop the run (and its validator) with the preview. Ctrl+C also reaches the child; it stops once either way.
  const stop = () => {
    if (exit !== null) process.exit(130);
    child.kill("SIGTERM");
    child.once("exit", () => process.exit(130));
    setTimeout(() => process.exit(130), 15_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    serve: (c: Context) => {
      if (exit !== null && exit !== 0) return c.text(`The live crowd run failed (exit ${exit}); see ${log}`, 500);
      if (!existsSync(file)) return c.text("The live crowd run is starting; it takes about a minute.", 503, { "retry-after": "2" });
      return c.body(readFileSync(file), 200, { "content-type": "application/json", "cache-control": "no-store" });
    },
  };
}
