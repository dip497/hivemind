// The website's hero: a recording of the real app, drawn one frame at a time. Its own profile, its
// own HOME, no PTY daemon, four demo projects with stand-in agents (scripts/site-clip-agent.mjs).
// Each frame moves every clock the app shows by 1/FPS of a second (the pages' animation frames and
// performance.now, their CSS animations, the stand-ins' clock), then the window is captured whole
// with capturePage. So the film runs at its own pace however slowly the machine draws, and a step
// starts at frame n, at exactly n/FPS seconds of the recording.
//
//   cd apps/desktop && env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE=x11 \
//     xvfb-run -n 91 -s "-screen 0 2560x1600x24" node scripts/site-clip.mjs <out-dir> \
//     --plugins <hivemind-plugins checkout> [--island <views/island/dist>] [--phone]
//
// The site needs two takes, `<wide>` and `<phone>` (the second with --phone), then
// `node scripts/site-clip-encode.mjs <wide> <phone>`. Re-running them re-shoots the whole clip,
// the Island part with it.
//
// The Island view, the CI light widget and the Flaky tests tool are installed from folders, the way
// an agent installs a plugin it just wrote. --phone records the same scene in a phone-shaped window
// for the site's phone clip. --probe draws the take without recording it.
// Out: raw.mkv (lossless), beats.json (when each step starts, in seconds of raw.mkv), a still of
// each beat and poster.png. scripts/site-clip-encode.mjs turns the two recordings into what the site serves.
import { _electron as electron } from "@playwright/test";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const AGENT = path.join(APP, "scripts/site-clip-agent.mjs");
const PUBLISHED_AGENTS = path.join(ROOT, "packages/hive-agents/tests/fixtures/published-agents");
const args = process.argv.slice(2);
const OUT = path.resolve(args[0] ?? "site-clip");
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : fallback; };
// --phone records the same scene in a window of a phone's shape (4:5), so the terminal wraps to fit.
const PHONE = args.includes("--phone");
const SIZE = PHONE ? { width: 448, height: 560 } : { width: Number(opt("width", 1280)), height: Number(opt("height", 800)) };
const SCALE = Number(opt("scale", 2));
const FPS = Number(opt("fps", 30));
const PLUGINS = path.resolve(opt("plugins", path.join(ROOT, "../hivemind-plugins")));
const ISLAND = path.resolve(opt("island", path.join(PLUGINS, "views/island/dist")));
const SKY = opt("sky", "day");
const PROBE = args.includes("--probe");
const W = SIZE.width * SCALE, H = SIZE.height * SCALE;

fs.mkdirSync(OUT, { recursive: true });
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "site-clip-"));
const BIN = path.join(HOME, ".bin"), XDG = path.join(HOME, ".config"), CUE = path.join(HOME, ".cue"), WORK = path.join(HOME, "work");
for (const d of [BIN, XDG, CUE, WORK]) fs.mkdirSync(d, { recursive: true });
const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();

// ── the recording's clock ──────────────────────────────────────────────────────────────────────
// Free (real time) while the scene is set up; while recording it moves only with each frame.
let clock = 1, lastReal = Date.now(), locked = false;
const writeClock = () => {
  try { fs.writeFileSync(path.join(CUE, "clock.tmp"), String(Math.round(clock))); fs.renameSync(path.join(CUE, "clock.tmp"), path.join(CUE, "clock")); } catch { /* gone */ }
};
const ticker = setInterval(() => { const n = Date.now(); if (!locked) { clock += n - lastReal; writeClock(); } lastReal = n; }, 40);
writeClock();

// ── the demo projects ──────────────────────────────────────────────────────────────────────────
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.email=you@example.com", "-c", "user.name=you", ...a], { cwd });
const PROJECTS = {
  storefront: {
    "README.md": "# storefront\n\nThe shop: cart, search and checkout.\n",
    "package.json": `${JSON.stringify({ name: "storefront", private: true, scripts: { test: "bun test" } }, null, 2)}\n`,
    "src/cart.ts": "export const total = (lines: { price: number; qty: number }[]) =>\n  Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;\n",
    // Two tests here fail on some runs and pass on others, the way a test that races does.
    "tests/cart.test.ts": `import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { total } from "../src/cart";
const file = \`\${process.env.HOME}/.storefront-runs\`;
let run = 0;
try { run = Number(readFileSync(file, "utf8")); } catch {}
writeFileSync(file, String(run + 1));
test("cart total rounds once", () => expect(total([{ price: 0.1, qty: 3 }])).toBe(0.3));
test("coupon applies once", () => expect(run % 3).not.toBe(1));
test("checkout keeps the address", () => expect(run % 4).not.toBe(2));
test("empty cart costs nothing", () => expect(total([])).toBe(0));
`,
    "tests/search.test.ts": `import { expect, test } from "bun:test";
const fold = (s: string) => s.normalize("NFD").replace(/\\p{M}/gu, "").toLowerCase();
test("search ignores accents", () => expect(fold("Crème")).toBe("creme"));
test("search ignores case", () => expect(fold("Shoes")).toBe("shoes"));
test("exact match ranks first", () => expect(["shoe", "shoes"].sort()[0]).toBe("shoe"));
`,
  },
  "payments-api": { "README.md": "# payments-api\n\nCharges, refunds and their webhooks.\n", "src/refunds/handler.go": "package refunds\n" },
  docs: { "README.md": "# docs\n\nGuides and the quickstart.\n", "guides/quickstart.md": "# Quickstart\n" },
  mobile: { "README.md": "# mobile\n\nThe shop's phone app.\n", "app/screens/Login.tsx": "export function Login() { return null; }\n" },
};
for (const [name, files] of Object.entries(PROJECTS)) {
  const dir = path.join(WORK, name);
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  git(WORK, "init", "-q", "-b", "main", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `Start ${name}`);
}

// ── the agents and the plugins ─────────────────────────────────────────────────────────────────
for (const kind of ["claude", "codex", "pi"]) {
  fs.writeFileSync(path.join(BIN, kind), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "0.0.0"; exit 0; }\nexec node ${AGENT} ${kind} "$@"\n`, { mode: 0o755 });
  fs.cpSync(path.join(PUBLISHED_AGENTS, kind), path.join(XDG, "hivemind", "agents", kind), { recursive: true });
}
const plugins = path.join(HOME, "plugins");
for (const [from, to] of [[ISLAND, "island"], [path.join(PLUGINS, "widgets/ci-light"), "ci-light"], [path.join(PLUGINS, "tools/flaky-tests"), "flaky-tests"]]) {
  if (!fs.existsSync(from)) throw new Error(`no ${from}`);
  fs.cpSync(from, path.join(plugins, to), { recursive: true });
}
const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
for (const rc of [".bash_profile", ".bashrc"]) fs.writeFileSync(path.join(HOME, rc), profile);
fs.writeFileSync(path.join(HOME, ".hushlogin"), "");

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !k.startsWith("HIVE") && !k.startsWith("GIT_") &&
  !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HCP_TOKEN", "USER", "LOGNAME", "MAIL", "OLDPWD"].includes(k)));
Object.assign(env, {
  XDG_CONFIG_HOME: XDG, HOME, USER: "you", LOGNAME: "you", SHELL: "/bin/bash", HISTFILE: "/dev/null",
  HIVEMIND_SHELL_ENV: "0", HIVEMIND_PTY_DAEMON: "0", CLIP_CUE: CUE,
  PATH: `${BIN}:${path.dirname(process.execPath)}:${path.dirname(bun)}:/usr/local/bin:/usr/bin:/bin`,
});
let hcp = {};
const writeHive = () => fs.writeFileSync(path.join(BIN, "hive"), `#!/usr/bin/env bash\n${Object.entries(hcp).map(([k, v]) => `export ${k}='${v}'\n`).join("")}exec ${bun} ${CLI} "$@"\n`, { mode: 0o755 });
writeHive();
const cliOpts = () => ({ cwd: path.join(WORK, "storefront"), encoding: "utf8", env: { ...env, ...hcp } });
const cli = (...a) => spawnSync(bun, [CLI, ...a], cliOpts());
/** The same, without stopping the frames while it runs. */
const cliAsync = (...a) => new Promise((resolve) => execFile(bun, [CLI, ...a], cliOpts(), (e, stdout) => resolve({ status: e ? (e.code ?? 1) : 0, stdout })));
const json = (...a) => { try { return JSON.parse(cli(...a, "--json").stdout); } catch { return null; } };

for (const [k, v] of [
  ["appearance.mode", "dark"],
  ["appearance.glass.enabled", true],
  ["appearance.glass.contentGlass", true],
  ["appearance.glass.opacity", 0.82],
  ["appearance.glass.contentOpacity", 0.57],
  ["appearance.glass.blur", 22],
  ["appearance.wallpaper.kind", "mono"],
  ["appearance.terminal.background", "#121416"],
]) cli("config", "set", k, JSON.stringify(v));

// The steps the lead agent runs: 0 when it starts, then one for each thing the person asks.
const steps = path.join(HOME, "steps");
fs.mkdirSync(steps, { recursive: true });
fs.writeFileSync(path.join(HOME, ".clip.sh"), `clock() { cat "$CLIP_CUE/clock" 2>/dev/null || echo 0; }
spin() { local start=$(clock) g=(✻ ✶ ✳ ✢); local end=$(( start + $2 )); local cols=$(stty size </dev/tty 2>/dev/null | cut -d' ' -f2); local more=" · esc to interrupt"; [ $(( \${#1} + 30 )) -gt "\${cols:-200}" ] && more=""; while [ "$(clock)" -lt "$end" ]; do local c=$(( $(clock) - start )); printf '\\r\\e[?25l\\e[38;5;208m%s\\e[0m %s… (%ss%s)\\e[K' "\${g[$(( c / 400 % 4 ))]}" "$1" $(( c / 1000 + 1 )) "$more"; sleep 0.03; done; printf '\\r\\e[K'; }
`);
// What the agent prints wraps to its terminal's width the way a real agent's does: at a space, or
// after a slash or a comma in a long path or JSON, with later lines under the text, not the bullet.
function printAsAgent() {
  const [kind, arg, text] = process.argv.slice(2);
  const width = process.stdout.columns || 200;
  const wrap = (line, w) => {
    const out = [];
    let chars = [...line];
    while (chars.length > w) {
      // A space unless it leaves the line short; then after a slash or comma; else mid-word.
      const last = (at) => { for (let i = w; i > 0; i--) if (at(i)) return i; return 0; };
      const space = last((i) => chars[i] === " ");
      const cut = space >= w / 2 ? space : last((i) => chars[i - 1] === "/" || chars[i - 1] === ",") || space || w;
      out.push(chars.slice(0, cut).join("").trimEnd());
      chars = chars.slice(cut);
      if (chars[0] === " ") chars = chars.slice(1);
    }
    out.push(chars.join(""));
    return out;
  };
  const print = (lines, first, rest, look = (l) => l) => lines.forEach((l, i) => process.stdout.write(`${i ? rest : first}${look(l, i)}\n`));
  if (kind === "bullet") {
    print(wrap(text, width - 3), `\x1b[${arg}m⏺\x1b[0m `, "  ", (l, i) => (i ? l : l.replace(/^([A-Za-z]+)\(/, "\x1b[1m$1\x1b[0m(")));
    return;
  }
  let input = "";
  process.stdin.on("data", (d) => { input += d; }).on("end", () => {
    const lines = input.replaceAll(process.env.HOME, "~").split("\n").filter((l, i, all) => i < all.length - 1 || l).map((l) => l.replace(/;.*/, "")).slice(0, Number(arg));
    print(lines.flatMap((l) => wrap(l, width - 6)), "  ⎿  ", "     ", (l) => `\x1b[38;5;244m${l}\x1b[0m`);
  });
}
fs.writeFileSync(path.join(HOME, ".print-as-agent.mjs"), `(${printAsAgent})();\n`);
const asAgent = `"${process.execPath}" ~/.print-as-agent.mjs`;
const say = (t) => `echo; ${asAgent} bullet 37 "${t}"`;
/** One real command as the agent runs it, with the first lines of what it printed. */
const run = (c, lines = 2) => `echo; ${asAgent} bullet 32 "Bash(${c.replace(/"/g, '\\"')})"; (${c}) 2>&1 | tee -a "$CLIP_CUE/printed" | ${asAgent} shown ${lines}`;
const spin = (task, ms) => `spin "${task}" ${ms}`;
const STEP = [
  // Printed once the window and the terminal have their filmed size, so it wraps to that size.
  [`until [ -f "$CLIP_CUE/sized" ]; do sleep 0.2; done`, run("hive views list", 4)],
  [spin("Reading the views guide", 1500), say("I'll add the Island view and switch to it."),
    run("hive views install ~/plugins/island && hive plugins enable view:@dip497/island", 1),
    `for k in "sky ${SKY}" "motion full" "frameRate 60"; do hive plugins set view:@dip497/island $k >/dev/null; done`,
    run("hive ctl plugin open view:@dip497/island", 1)],
  [spin("Reading the widgets guide", 1500), say("I'll put a CI light on the board and run the build."),
    run("hive widgets install ~/plugins/ci-light && hive plugins enable widget:@dip497/ci-light", 1),
    run("hive ctl plugin open widget:@dip497/ci-light", 1),
    run(`hive ctl plugin call @dip497/ci-light set '{"state":"running","name":"CI"}'`, 0),
    spin("Running the build", 2500),
    run(`hive ctl plugin call @dip497/ci-light set '{"state":"passed","name":"CI","detail":"typecheck, build and unit tests"}'`, 0)],
  [spin("Reading the tools guide", 1500), say("I'll add the Flaky tests tool and open it on the canvas."),
    run("hive tools install ~/plugins/flaky-tests && hive plugins enable tool:dip497/flaky-tests", 1),
    run("hive plugins set tool:dip497/flaky-tests runs 4", 0),
    run("hive ctl open-tool dip497/flaky-tests/flaky", 0),
    `for i in $(seq 30); do hive ctl plugin call dip497/flaky-tests run >/dev/null 2>&1 && break; sleep 0.5; done`,
    run("hive ctl plugin call dip497/flaky-tests flaky", 3)],
];
STEP.forEach((s, i) => fs.writeFileSync(path.join(steps, `${i}.sh`), `source ~/.clip.sh\n${s.join("\n")}\n`));

// ── each page's clock ──────────────────────────────────────────────────────────────────────────
// Installed in every page before its own script: free until locked, then animation frames run and
// performance.now moves only on step(ms).
const PAGE_CLOCK = () => {
  if (window.__clip) return;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  let locked = false, off = 0, v = 0;
  const queue = [];
  const now = () => (locked ? v : realNow() + off);
  performance.now = now;
  window.requestAnimationFrame = (cb) => { if (locked) { queue.push(cb); return queue.length; } return realRaf(() => cb(now())); };
  window.__clip = {
    lock() { if (!locked) { v = now(); locked = true; } },
    unlock() { if (locked) { off = v - realNow(); locked = false; for (const cb of queue.splice(0)) realRaf(() => cb(now())); } },
    step(ms) {
      v += ms;
      for (const cb of queue.splice(0)) { try { cb(v); } catch (e) { console.error(e); } }
      return new Promise((r) => realRaf(() => realRaf(() => r(true))));
    },
  };
};

const app = await electron.launch({
  args: [path.join(APP, "out/main/index.js"), "--no-sandbox", `--force-device-scale-factor=${SCALE}`],
  cwd: path.join(WORK, "storefront"), env,
});
await app.context().addInitScript(PAGE_CLOCK);
const page = await app.firstWindow();
page.setDefaultTimeout(120_000);
page.on("pageerror", (e) => console.error("[renderer]", e.message));
await app.evaluate(({ app: a, ipcMain }) => {
  ipcMain.removeHandler("checkForUpdate");
  ipcMain.handle("checkForUpdate", () => ({ current: a.getVersion(), latest: a.getVersion(), updateAvailable: false, ok: true }));
});
await app.evaluate(({ BrowserWindow }, s) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setMinimumSize(1, 1);
  w.setPosition(0, 0);
  w.setContentSize(s.width, s.height);
}, SIZE);
await page.reload();
await page.waitForSelector(".react-flow", { timeout: 60_000 });
const hostCdp = await page.context().newCDPSession(page);
await hostCdp.send("Animation.enable");

const userData = await (async () => {
  for (let i = 0; i < 120; i++) {
    const d = fs.readdirSync(XDG).map((x) => path.join(XDG, x)).find((x) => fs.existsSync(path.join(x, "hcp.token")));
    if (d) return d;
    await page.waitForTimeout(250);
  }
  throw new Error("the app never opened its control socket");
})();
hcp = { HIVEMIND_APP_DATA: userData, HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
writeHive();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the scene, set before the camera runs ──────────────────────────────────────────────────────
const frames = {};
const addFrame = async (p) => {
  let r = null;
  for (let k = 0; k < 20 && !r?.frame; k++) { r = json("ctl", "frame", "add", "--folder", path.join(WORK, p), "--name", p); if (!r?.frame) await wait(1000); }
  frames[p] = typeof r.frame === "string" ? r.frame : r.frame?.id;
};
const tiles = {};
const spawnAgent = async (kind, project, name, prompt) => {
  let r = null;
  for (let k = 0; k < 30 && !r?.tile; k++) {
    r = json("ctl", "spawn", "--agent", kind, "--frame", frames[project], "--name", name, ...(prompt ? ["--prompt", prompt] : []));
    if (!r?.tile) await wait(1000);
  }
  if (!r?.tile) throw new Error(`${name} did not start`);
  tiles[name] = r.tile;
};
const WORKERS = [
  ["pi", "storefront", "search", "make search ignore accents"],
  ["codex", "payments-api", "refunds", "retry the refund webhook"],
  ["claude", "docs", "guides", "rewrite the docs quickstart"],
  ["pi", "mobile", "login", "show a spinner on the login button"],
  ["codex", "mobile", "cart-sync", "sync the cart offline"],
];
// One project at a time, its agents in it before the next frame is placed, so no frame lands on another.
for (const p of Object.keys(PROJECTS)) {
  await addFrame(p);
  if (p === "storefront") await spawnAgent("claude", p, "my-workspace", "lead");
  for (const [kind, project, name] of WORKERS) if (project === p) await spawnAgent(kind, project, name);
  await wait(1500);
}
const lead = tiles["my-workspace"];
const cue = (name, what) => fs.writeFileSync(path.join(CUE, tiles[name].replace(/^hm:/, "")), what);
await wait(4000);
// The Island is opened once off camera and removed again, so when the agent installs it on camera
// its code and shaders are warm and `plugin open` finds it ready, as on a machine that has run it.
{
  cli("views", "install", path.join(HOME, "plugins/island"));
  cli("plugins", "enable", "view:@dip497/island");
  cli("ctl", "plugin", "open", "view:@dip497/island");
  for (let end = Date.now() + 120_000; Date.now() < end; await wait(1000)) {
    const census = cli("ctl", "plugin", "call", "@dip497/island", "census");
    if (census.status === 0) break;
    if (/stopped|did not start/.test(`${census.stdout}${census.stderr}`)) {
      cli("ctl", "plugin", "close", "view:@dip497/island");
      await wait(2000);
      cli("ctl", "plugin", "open", "view:@dip497/island");
    }
  }
  await wait(3000);
  cli("ctl", "plugin", "open", "view:canvas");
  await wait(1500);
  cli("views", "remove", "@dip497/island");
}
// Turns finished earlier today, so the islands already have houses; then most of them at work.
for (let round = 0; round < 4; round++) {
  for (const [, , name, task] of WORKERS) cue(name, `work ${task}`);
  await wait(2600);
  for (const [, , name] of WORKERS) cue(name, "finish");
  await wait(2200);
}
for (const [, , name, task] of WORKERS.slice(0, 4)) cue(name, `work ${task}`);

// The camera opens on the agent the person talks to, at 100%, so its text reads on the page.
// On a phone's width the projects list would take half the screen: the canvas gets all of it.
if (PHONE) { await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-layers"))); await wait(1500); }
// The window as the camera sees it; the app may have put back a size it remembered.
for (let i = 0; i < 20; i++) {
  const got = await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w.isMaximized()) w.unmaximize();
    w.setMinimumSize(1, 1);
    w.setContentSize(s.width, s.height);
    return w.getContentSize();
  }, SIZE);
  if (got[0] === SIZE.width && got[1] === SIZE.height) break;
  if (i === 19) throw new Error(`the window stays ${got.join("x")}`);
  await wait(500);
}
// A tile is sized to what the screen shows, so its lines wrap to fit, the way a person drags its
// corner.
async function resizeTile(id, width, height) {
  const node = page.locator(`.react-flow__node[data-id="${id}"]`).first();
  // Its corner shows only while it is selected: focusing it selects it and brings it to 100%, then
  // the view steps out until the whole tile, corner and all, is on screen.
  const selected = async () => (await node.locator(".hm-node-selected").count()) > 0;
  cli("ctl", "focus", id);
  await wait(1500);
  for (let i = 0; i < 6 && !(await selected()); i++) {
    const head = await node.locator(".tile-drag-handle").first().boundingBox();
    if (head) await page.mouse.click(head.x + head.width / 2, head.y + head.height / 2);
    await wait(1200);
  }
  if (!(await selected())) throw new Error(`${id} would not select`);
  for (let i = 0; i < 8; i++) {
    const b = await node.boundingBox();
    if (b && b.x >= 0 && b.y >= 0 && b.x + b.width <= SIZE.width - 8 && b.y + b.height <= SIZE.height - 8) break;
    const out = page.getByTitle("Zoom out (Ctrl -)").first();
    if (await out.isVisible()) await out.click(); else await page.keyboard.press("Control+Minus");
    await wait(400);
  }
  // A finished turn's card in the corner would take the drag.
  await clearCards(10_000);
  const zoom = await page.$eval(".react-flow__viewport", (e) => new DOMMatrix(getComputedStyle(e).transform).a);
  let got = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const box = await node.boundingBox();
    const corner = await node.locator(".react-flow__resize-control.handle.bottom.right").first().boundingBox({ timeout: 10_000 });
    if (!box || !corner) throw new Error("no corner to drag");
    const from = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + width * zoom, box.y + height * zoom, { steps: 12 });
    await page.mouse.up();
    await wait(1000);
    got = await node.evaluate((e) => [e.offsetWidth, e.offsetHeight]);
    if (Math.abs(got[0] - width) <= 8 && Math.abs(got[1] - height) <= 8) break;
  }
  console.log(`${id} is ${got.join("x")}`);
  if (Math.abs(got[0] - width) > 8 || Math.abs(got[1] - height) > 8) throw new Error(`${id} stayed ${got.join("x")}, not ${width}x${height}`);
}
/** Wait for the cards of finished turns to leave; one still there after `ms` (a card pauses while
 *  the window has lost focus) is dismissed with its own button, as a person would. */
async function clearCards(ms) {
  for (const end = Date.now() + ms; Date.now() < end && (await page.locator(".hm-toast").count()); ) await wait(300);
  for (const x of await page.locator('.hm-toast [aria-label="Dismiss notification"]').all()) await x.click({ force: true }).catch(() => {});
  await wait(600);
}
// The CI light's card sits in the top right corner: the terminal and the tool are sized and placed
// to fill the screen below it and right of the projects list, so the card covers none of their
// lines and none run off the edge.
const TILE = { left: 12, width: 0, height: SIZE.height - 54 - 176, top: 176 };
/** Bring a tile to the screen at 100%, its top just below the card. */
async function place(id) {
  const focused = cli("ctl", "focus", id);
  if (focused.status !== 0) throw new Error(`focus ${id}: ${focused.stdout}${focused.stderr}`);
  await wait(1500);
  const node = page.locator(`.react-flow__node[data-id="${id}"]`).first();
  let perPixel = 2;
  for (let i = 0; i < 8; i++) {
    const box = await node.boundingBox();
    const before = box.y;
    const off = TILE.top - before;
    if (Math.abs(off) < 2) return;
    // A turn of the wheel over the canvas itself pans it; other tiles may sit all round this one,
    // so the turn goes to the canvas, not to whatever is under the pointer.
    await page.evaluate(([dy, x, y]) => document.querySelector(".react-flow__pane")
      .dispatchEvent(new WheelEvent("wheel", { deltaY: dy, clientX: x, clientY: y, bubbles: true, cancelable: true })), [-off * perPixel, box.x + box.width / 2, box.y + box.height / 2]);
    await wait(900);
    const moved = (await node.boundingBox()).y - before;
    if (Math.abs(moved) > 1) perPixel = Math.min(8, Math.max(0.25, Math.abs((off * perPixel) / moved)));
  }
  throw new Error(`${id} would not move to the top ${TILE.top}`);
}
{
  // Where the canvas starts on screen: at 100% the agent's tile is drawn from there.
  cli("ctl", "focus", lead);
  // Measured once the camera has landed: the same place three times running.
  let left = NaN;
  for (let i = 0, same = 0; i < 40 && same < 3; i++) {
    await wait(300);
    const x = Math.round((await page.locator(`.react-flow__node[data-id="${lead}"]`).first().boundingBox()).x);
    same = x === left ? same + 1 : 0;
    left = x;
  }
  TILE.left = PHONE ? 12 : Math.round(Math.max(12, left));
  TILE.width = SIZE.width - TILE.left - 12;
}
await resizeTile(lead, TILE.width, TILE.height);
await place(lead);
fs.writeFileSync(path.join(CUE, "sized"), "");
/** The pointer leaves what it clicked, so no tooltip stays in the shot. */
// Not over the cards in the corner: a card under the pointer stays.
const rest = () => page.mouse.move(SIZE.width * 0.4, SIZE.height * 0.3);
await rest();
// The finished turns' cards leave after 7 s.
await wait(9000);
await clearCards(30_000);

// ── the camera ─────────────────────────────────────────────────────────────────────────────────
const FRAME_MS = 1000 / FPS;
let kept = 0, lastStep = Date.now();
const within = (p, ms, fallback) => Promise.race([p, wait(ms).then(() => fallback)]);
const pageFrames = () => page.frames().filter((f) => !f.isDetached());
async function eachPage(fn, arg) {
  await Promise.all(pageFrames().map((f) => within(f.evaluate(fn, arg).catch(() => null), 6000, null)));
}
const sessions = new Map();
/** CSS animations run on each page's own clock: hold them to one frame's worth per frame. */
async function cssRate(rate) {
  await hostCdp.send("Animation.setPlaybackRate", { playbackRate: rate }).catch(() => {});
  for (const f of pageFrames()) {
    if (f === page.mainFrame()) continue;
    if (!sessions.has(f)) {
      const s = await within(page.context().newCDPSession(f).then(async (c) => { await c.send("Animation.enable"); return c; }).catch(() => null), 3000, null);
      sessions.set(f, s);
    }
    await sessions.get(f)?.send("Animation.setPlaybackRate", { playbackRate: rate }).catch(() => {});
  }
}
async function lockAll() { locked = true; await eachPage(() => window.__clip?.lock()); }
async function unlockAll() { await eachPage(() => window.__clip?.unlock()); await cssRate(1); lastReal = Date.now(); locked = false; }

if (!PROBE) {
  await app.evaluate(({ }, a) => {
    const cp = process.mainModule.require("child_process");
    const ff = cp.spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${a.w}x${a.h}`, "-framerate", String(a.fps), "-i", "-",
      "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", a.file], { stdio: ["pipe", "ignore", "pipe"] });
    globalThis.__rec = { ff, err: "" };
    ff.stderr.on("data", (d) => { globalThis.__rec.err = (globalThis.__rec.err + d).slice(-4000); });
  }, { w: W, h: H, fps: FPS, file: path.join(OUT, "raw.mkv") });
}
/** Capture the window as it is now and hold it; false when it came back at another size. */
const capture = () => app.evaluate(async ({ BrowserWindow }, a) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  const s = img.getSize();
  if (s.width !== a.w || s.height !== a.h) return false;
  globalThis.__held = img.toBitmap();
  return true;
}, { w: W, h: H });
/** Put the held capture in the film. */
const keep = () => app.evaluate(async () => {
  if (globalThis.__rec) await new Promise((r) => globalThis.__rec.ff.stdin.write(globalThis.__held, r));
  globalThis.__held = null;
});

/** One frame of film: every clock moves 1/FPS of a second, then the window is captured. When
 *  `leaving()` holds once it is captured, the screen may have started to change mid-capture, so the
 *  frame is dropped and false returned. */
async function frame(leaving) {
  clock += FRAME_MS;
  writeClock();
  const real = Date.now();
  await cssRate(Math.max(0.002, Math.min(1, FRAME_MS / Math.max(1, real - lastStep))));
  lastStep = real;
  await eachPage((ms) => { window.__clip?.lock(); return window.__clip?.step(ms); }, FRAME_MS);
  await wait(40);
  for (let i = 0; !(await capture()); i++) {
    if (i > 20) throw new Error(`frame ${kept} came back at another size`);
    await wait(200);
  }
  if (leaving && (await leaving())) return false;
  await keep();
  kept++;
  if (kept % FPS === 0) console.log(`  ${(kept / FPS).toFixed(0)} s of film`);
  return true;
}
/** Film until the app starts to leave this screen (a view switch); that frame is not kept. */
async function filmUntilLeaving(leaving, seconds) {
  for (let i = Math.round(seconds * FPS); i > 0; i--) if (!(await frame(leaving))) return;
  console.error("filmUntilLeaving: ran out of time");
}
const film = async (seconds) => { for (let i = Math.round(seconds * FPS); i > 0; i--) await frame(); };
/** Film until `ok()` holds; `ok` may take real time (a CLI start) while the frames go on. */
async function filmUntil(ok, seconds) {
  let pending = null, done = false;
  for (let i = Math.round(seconds * FPS); i > 0 && !done; i--) {
    if (!pending) pending = Promise.resolve(ok()).then((v) => { done = !!v; pending = null; });
    await frame();
  }
  if (pending) await pending;
  if (!done) console.error("filmUntil: ran out of time");
}
/** Let the app run in real time without filming: a view loading or switching, cut in one step. */
async function offCamera(fn) {
  await unlockAll();
  await fn();
  await lockAll();
}

const beats = [];
const mark = async (key) => {
  beats.push({ key, frame: kept, at: Math.round((kept / FPS) * 1000) / 1000 });
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(path.join(OUT, `beat-${beats.length}-${key}.png`), Buffer.from(png, "base64"));
};

/** Click into the terminal that fills most of the screen, the way a person would. */
const clickTerminal = async () => {
  const i = await page.$$eval(".xterm-screen", (els) => {
    let best = -1, area = 0;
    els.forEach((e, n) => {
      if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return;
      const r = e.getBoundingClientRect();
      const v = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (v > area) { area = v; best = n; }
    });
    return best;
  });
  if (i < 0) throw new Error("no terminal on screen");
  await page.locator(".xterm-screen").nth(i).click();
};
/** Type at a person's pace: a key every other frame, a little longer after a space. */
const ask = async (text) => {
  await clickTerminal();
  await rest();
  for (const ch of text) {
    await page.keyboard.type(ch);
    await film((ch === " " ? 3 : 2) / FPS);
  }
  await film(0.35);
  await page.keyboard.press("Enter");
};
/** A key for the view itself (its + and - zoom), given to its page, not to whatever holds focus. */
const viewKey = (key) => islandPage()?.evaluate((k) => { for (const type of ["keydown", "keyup"]) document.body.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true })); }, key).catch(() => {});
const islandPage = () => pageFrames().find((f) => /^hm-view:/.test(f.name()) && f.name().includes("island"));
const terminalShown = () => page.$$eval(".xterm-screen", (els) => els.some((e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true })));

let failed = null;
try {
  await lockAll();
  // 1. the person asks for a view; the agent installs the Island view and switches to it
  await mark("view");
  await film(1);
  await ask("Show my workspace as islands.");
  // The switch starts when the toolbar names the Island view; nothing of it is filmed.
  await filmUntilLeaving(async () => !!islandPage() || await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Island")), 90);
  // The view loads off camera, so the film cuts from the terminal to the islands drawn.
  await offCamera(async () => {
    // Close on the island the person works on, not the whole sea. On a slow machine the view can
    // miss its start time and stop; it is opened again until the flight is taken.
    const fly = () => cli("ctl", "plugin", "call", "@dip497/island", "island", JSON.stringify({ name: "storefront" }));
    let flown;
    for (const end = Date.now() + 180_000; Date.now() < end; ) {
      const census = cli("ctl", "plugin", "call", "@dip497/island", "census");
      if (census.status === 0) { await wait(3000); flown = fly(); if (flown.status === 0) break; }
      const said = `${census.stdout}${census.stderr}${flown?.stdout ?? ""}${flown?.stderr ?? ""}`;
      console.error(`island storefront, not yet: ${said.trim().slice(0, 300)}`);
      // A view that missed its start time stays failed until it is closed and opened again.
      if (/stopped|did not start/.test(said)) {
        cli("ctl", "plugin", "close", "view:@dip497/island");
        await wait(2000);
        cli("ctl", "plugin", "open", "view:@dip497/island");
      }
      await wait(2000);
    }
    if (flown?.status !== 0) throw new Error("the Island view never flew to storefront");
    // Once more when the first flight has landed: the view's opening descent can take the camera back.
    await wait(2500);
    const again = fly();
    if (again.status !== 0) throw new Error(`island storefront: ${again.stdout}${again.stderr}`);
    await wait(5000);
  });
  // What the agent printed is on camera when the film comes back to it.
  const printed = fs.readFileSync(path.join(CUE, "printed"), "utf8");
  if (!/switched to view @dip497\/island: ready/.test(printed)) throw new Error(`the Island was not ready when the agent opened it: ${printed.trim().split("\n").pop()}`);
  await mark("island");
  await film(0.8);
  // A new agent starts on the island: its worker and workshop appear, and it goes to work.
  const started = cliAsync("ctl", "spawn", "--agent", "codex", "--frame", frames.storefront, "--name", "checkout", "--json");
  await viewKey("+");
  await film(2);
  // The search agent finishes its turn: its next lot goes up.
  cue("search", "finish");
  await film(1.6);
  try { tiles.checkout = JSON.parse((await started).stdout).tile; cue("checkout", "work round the cart total"); } catch { console.error("checkout did not start"); }
  await viewKey("+");
  await film(3);
  // Back to the agent's terminal, at full size.
  await offCamera(async () => {
    cli("ctl", "plugin", "open", "view:canvas");
    await place(lead);
    await rest();
    const end = Date.now() + 30_000;
    while (Date.now() < end && !(await terminalShown())) await wait(300);
    // and the card for the turn finished on the island has gone
    await clearCards(12_000);
    await wait(1500);
  });
  // 2. a widget
  await mark("widget");
  await film(0.6);
  await ask("Put a CI light where I can see it.");
  await filmUntil(async () => (await cliAsync("ctl", "plugin", "call", "@dip497/ci-light", "status")).stdout.includes("passed"), 90);
  await film(3);
  // 3. a tool
  await mark("tool");
  await film(0.6);
  await ask("Find the flaky tests.");
  const flaky = async () => (await cliAsync("ctl", "plugin", "call", "dip497/flaky-tests", "flaky")).status === 0;
  {
    // The tool opens at its own size: it is sized to the screen off camera, then filmed whole.
    const toolTile = () => page.evaluate(() => [...document.querySelectorAll(".react-flow__node")].find((n) => n.textContent.includes("Flaky tests #"))?.getAttribute("data-id") ?? null);
    // Its id is kept when it first shows: the canvas draws only the tiles in view.
    let id = null;
    await filmUntilLeaving(async () => !!(id = await toolTile()), 120);
    await offCamera(async () => {
      await resizeTile(id, TILE.width, TILE.height);
      // Further under the agent's terminal, in the same frame, so the strip above the tool shows the
      // frame's empty floor rather than the terminal's last lines.
      const leadNode = page.locator(`.react-flow__node[data-id="${lead}"]`).first();
      const toolNode = page.locator(`.react-flow__node[data-id="${id}"]`).first();
      let leadBox, toolBox, to;
      for (let i = 0; i < 8; i++) {
        [leadBox, toolBox] = [await leadNode.boundingBox(), await toolNode.boundingBox()];
        const zoom = await page.$eval(".react-flow__viewport", (e) => new DOMMatrix(getComputedStyle(e).transform).a);
        to = { x: toolBox.x, y: leadBox.y + leadBox.height + (TILE.top + 80) * zoom };
        const shown = (b) => b.x >= 0 && b.y >= 0 && b.x + b.width <= SIZE.width;
        if (to.y + 40 <= SIZE.height - 60 && shown(toolBox) && shown(leadBox)) break;
        const out = page.getByTitle("Zoom out (Ctrl -)").first();
        if (await out.isVisible()) await out.click(); else await page.keyboard.press("Control+Minus");
        await wait(500);
      }
      const head = await toolNode.locator(".tile-drag-handle").first().boundingBox();
      const grip = { x: head.x + head.width * 0.35, y: head.y + head.height / 2 };
      // The widget cards float over everything; for the drag they are set aside, so it lands on the tile.
      await page.evaluate(() => { document.querySelector("[data-widget-layer]").style.visibility = "hidden"; });
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + (to.x - toolBox.x) / 2, grip.y + (to.y - toolBox.y) / 2, { steps: 6 });
      await page.mouse.move(grip.x + to.x - toolBox.x, grip.y + to.y - toolBox.y, { steps: 6 });
      await page.mouse.up();
      await page.evaluate(() => { document.querySelector("[data-widget-layer]").style.visibility = ""; getSelection()?.removeAllRanges(); });
      await wait(1200);
      const moved = await toolNode.boundingBox();
      console.log(`${id} moved from ${Math.round(toolBox.x)},${Math.round(toolBox.y)} to ${Math.round(moved.x)},${Math.round(moved.y)}; the terminal is at ${Math.round(leadBox.x)},${Math.round(leadBox.y)}`);
      await place(id);
      await rest();
      for (const end = Date.now() + 120_000; Date.now() < end && !(await flaky()); ) await wait(500);
      await wait(1500);
    });
  }
  await film(4);
  await mark("end");
} catch (e) {
  failed = e;
} finally {
  if (!PROBE) {
    const r = await app.evaluate(async () => {
      const rec = globalThis.__rec;
      await new Promise((r) => { rec.ff.on("close", r); rec.ff.stdin.end(); });
      return rec.err;
    });
    if (r) console.error(`ffmpeg: ${r}`);
  }
  clearInterval(ticker);
  await page.screenshot({ path: path.join(OUT, "poster.png") }).catch(() => {});
  fs.writeFileSync(path.join(OUT, "beats.json"), `${JSON.stringify(beats, null, 2)}\n`);
  const pid = app.process().pid;
  await Promise.race([app.close(), wait(8000)]).catch(() => {});
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  // The stand-ins and shells the app started, found by this run's cue folder.
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { if (fs.readFileSync(`/proc/${p}/environ`, "utf8").includes(`CLIP_CUE=${CUE}\0`)) process.kill(Number(p), "SIGKILL"); } catch { /* not ours, or gone */ }
  }
  fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
if (failed) throw failed;
console.log(JSON.stringify(beats));
