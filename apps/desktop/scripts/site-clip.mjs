// The website's hero: a recording of the real app, drawn one frame at a time. Its own profile, its
// own HOME, no PTY daemon, four demo projects with stand-in agents (scripts/site-clip-agent.mjs).
// Each frame moves every clock the app shows by 1/FPS of a second (the pages' animation frames and
// performance.now, their CSS animations, the stand-ins' clock), then the window is captured whole
// with capturePage. So the film runs at its own pace however slowly the machine draws, and a step
// starts at frame n, at exactly n/FPS seconds of the recording.
//
//   cd apps/desktop && env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE=x11 \
//     xvfb-run -n 91 -s "-screen 0 2560x1600x24" node scripts/site-clip.mjs <out-dir> \
//     --plugins <hivemind-plugins checkout> [--island <views/island/dist>]
//
// The Island view, the CI light widget and the Flaky tests tool are installed from folders, the way
// an agent installs a plugin it just wrote. --probe draws the take without recording it.
// Out: raw.mkv (lossless), beats.json (when each step starts, in seconds of raw.mkv), a still of
// each beat and poster.png. scripts/site-clip-encode.mjs turns one recording into what the site serves.
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
const SIZE = { width: Number(opt("width", 1280)), height: Number(opt("height", 800)) };
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
spin() { local start=$(clock) g=(✻ ✶ ✳ ✢); local end=$(( start + $2 )); while [ "$(clock)" -lt "$end" ]; do local c=$(( $(clock) - start )); printf '\\r\\e[?25l\\e[38;5;208m%s\\e[0m %s… (%ss · esc to interrupt)  ' "\${g[$(( c / 400 % 4 ))]}" "$1" $(( c / 1000 + 1 )); sleep 0.03; done; printf '\\r\\e[K'; }
`);
const say = (t) => `printf '\\n\\e[37m⏺\\e[0m %s\\n' "${t}"`;
/** One real command as the agent runs it, with the first lines of what it printed. */
const run = (c, lines = 2) => `printf '\\n\\e[32m⏺\\e[0m \\e[1mBash\\e[0m(%s)\\n' "${c.replace(/"/g, '\\"')}"; (${c}) 2>&1 | sed -e "s#$HOME#~#g" -e 's/;.*//' -e 's/^/  \\x1b[38;5;244m⎿  /' -e 's/$/\\x1b[0m/' | head -n ${lines}`;
const spin = (task, ms) => `spin "${task}" ${ms}`;
const STEP = [
  [run("hive views list", 4)],
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
// Turns finished earlier today, so the islands already have houses; then most of them at work.
for (let round = 0; round < 4; round++) {
  for (const [, , name, task] of WORKERS) cue(name, `work ${task}`);
  await wait(2600);
  for (const [, , name] of WORKERS) cue(name, "finish");
  await wait(2200);
}
for (const [, , name, task] of WORKERS.slice(0, 4)) cue(name, `work ${task}`);

// The camera opens on the agent the person talks to, at 100%, so its text reads on the page.
const focused = cli("ctl", "focus", lead);
if (focused.status !== 0) throw new Error(`focus ${lead}: ${focused.stdout}${focused.stderr}`);
/** The pointer leaves what it clicked, so no tooltip stays in the shot. */
const rest = () => page.mouse.move(SIZE.width * 0.5, SIZE.height * 0.6);
await rest();
// The finished turns' cards leave after 7 s.
await wait(9000);

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
    const end = Date.now() + 90_000;
    while (Date.now() < end && cli("ctl", "plugin", "call", "@dip497/island", "census").status !== 0) await wait(500);
    await wait(3000);
    // Close on the island the person works on, not the whole sea.
    cli("ctl", "plugin", "call", "@dip497/island", "island", JSON.stringify({ name: "storefront" }));
    await wait(5000);
  });
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
    cli("ctl", "focus", lead);
    await rest();
    const end = Date.now() + 30_000;
    while (Date.now() < end && !(await terminalShown())) await wait(300);
    // and the card for the turn finished on the island has gone
    for (const until = Date.now() + 12_000; Date.now() < until && (await page.locator(".hm-toast").count()); ) await wait(300);
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
  await filmUntil(async () => (await cliAsync("ctl", "plugin", "call", "dip497/flaky-tests", "flaky")).status === 0, 120);
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
