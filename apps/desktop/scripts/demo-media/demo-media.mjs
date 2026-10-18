// Makes the website's demo clips again, from nothing:
//   1. the demo workspace (demo-workspace.sh), 2. a recording of the real app and agents over it
//   (capture.spec.ts, under xvfb), 3. the clips rendered from that recording (render/render.mjs).
//
//   node scripts/demo-media/demo-media.mjs            # all three (from apps/desktop, after pnpm build)
//   node scripts/demo-media/demo-media.mjs --render   # only render, from the recording already made
//
// A recording costs real agent time; rendering from it is free and gives the same files each time.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "../..");
const DEMO = process.env.DEMO_HOME ?? "/tmp/hivemind-demo";
const RECORDING = process.env.DEMO_OUT ?? path.join(os.homedir(), "hivemind-demo-recording");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

if (!process.argv.includes("--render")) {
  run(path.join(HERE, "demo-workspace.sh"), [DEMO]);
  const env = { ...process.env, DEMO_HOME: DEMO, DEMO_OUT: RECORDING };
  for (const name of ["ELECTRON_RUN_AS_NODE", "WAYLAND_DISPLAY"]) delete env[name];
  // Low priority: a capture or a render must not slow the machine it runs on.
  run("nice", ["-n", "15", "xvfb-run", "-a", "-s", "-screen 0 1700x1100x24", "npx", "playwright", "test", "--config", "scripts/demo-media/capture.config.ts", "capture.spec.ts"], { cwd: DESKTOP, env });
}

// The scene the clips promise, as the recording counted it; no render from a wrong one.
const cues = JSON.parse(fs.readFileSync(path.join(RECORDING, "cues.json"), "utf8"));
const wrong = [];
// The opening: two agents at their jobs and one waiting on the person.
if ((cues.census.before.working ?? 0) < 2 || (cues.census.before.waiting ?? 0) !== 1) wrong.push(`the opening needs two agents working and one waiting, saw ${JSON.stringify(cues.census.before)}`);
if (!cues.widget.id) wrong.push("the agent put no widget on the board");
const criteria = cues.widget.list ?? [];
if (!criteria.length || criteria.some((c) => !c.done)) wrong.push("the issue the widget tracks was not ticked off");
const unreadable = (cues.widget.drawn ?? []).findIndex((t) => t.includes("[object "));
if (unreadable >= 0) wrong.push(`the widget printed an object as text in building frame ${unreadable}`);
if (Object.entries(cues.census.asking).filter(([k]) => k === "waiting").reduce((n, [, v]) => n + v, 0) !== 1) wrong.push(`the phone clip needs one agent waiting, saw ${JSON.stringify(cues.census.asking)}`);
if (wrong.length) {
  console.error(`not rendering, the recording is wrong:\n  ${wrong.join("\n  ")}`);
  process.exit(1);
}

const render = path.join(HERE, "render");
if (!fs.existsSync(path.join(render, "node_modules"))) run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: render });
run("nice", ["-n", "15", "node", "render.mjs", "--recording", RECORDING], { cwd: render });
