// The website's hero: a screen recording of the real app. Its own profile, its own HOME, no PTY
// daemon, a clone of this repository; ffmpeg records the X display, so what lands in the file is
// the app itself. Recorded at twice the window's size, so its text stays sharp on a retina screen.
//
//   cd apps/desktop && env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS XDG_SESSION_TYPE=x11 \
//     xvfb-run -n 91 -s "-screen 0 2560x1600x24" node scripts/site-clip.mjs <out-dir> --plugins <dir>
//
// --plugins is a checkout of hivemind-plugins: the Island view, the CI light widget and the
// Flaky tests tool are installed from it, the way an agent installs a plugin it just wrote.
// Out: raw.mkv (lossless), beats.json (when each step starts, in seconds) and poster.png.
// scripts/site-clip-encode.mjs turns one recording into what the site serves.
import { _electron as electron } from "@playwright/test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const args = process.argv.slice(2);
const OUT = path.resolve(args[0] ?? "site-clip");
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : fallback; };
const SIZE = { width: Number(opt("width", 1280)), height: Number(opt("height", 800)) };
const SCALE = Number(opt("scale", 2));
const FPS = Number(opt("fps", 30));
const PLUGINS = path.resolve(opt("plugins", path.join(ROOT, "../hivemind-plugins")));

fs.mkdirSync(OUT, { recursive: true });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const HOME = tmp("home-"), BIN = path.join(HOME, ".bin"), XDG = path.join(HOME, ".config");
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(XDG, { recursive: true });

// The agents run under each agent's published manifest; the CLI each one runs is a stand-in that
// prints the screens the real status detector reads, so statuses and views are real. A prompt
// reaches claude and pi as argv and codex typed at its prompt.
for (const cli of ["claude", "codex", "pi"]) {
  fs.writeFileSync(path.join(BIN, cli), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "0.0.0 (clip stand-in)"; exit 0; }
printf '\\e[?25l'
cmd=""
${cli === "codex" ? "" : `for a in "$@"; do case "$a" in -*) ;; *) cmd="$a" ;; esac; done`}
if [ -n "$cmd" ]; then clear; printf '\\e[?25l'; exec bash -c "$cmd"; fi
printf '\\n❯ '
IFS= read -r line
clear; printf '\\e[?25l'
exec bash -c "$line"
`, { mode: 0o755 });
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !k.startsWith("HIVE") && !k.startsWith("GIT_") &&
  !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HCP_TOKEN", "USER", "LOGNAME", "MAIL", "OLDPWD"].includes(k)));
Object.assign(env, {
  XDG_CONFIG_HOME: XDG, HOME, USER: "you", LOGNAME: "you", HIVEMIND_SHELL_ENV: "0", HIVEMIND_PTY_DAEMON: "0",
  PATH: `${BIN}:${path.dirname(process.execPath)}:${path.dirname(spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim())}:/usr/local/bin:/usr/bin:/bin`,
});

// `hive` on the agents' PATH is this checkout's CLI.
const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
fs.writeFileSync(path.join(BIN, "hive"), `#!/usr/bin/env bash\nexec ${bun} ${CLI} "$@"\n`, { mode: 0o755 });

const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
fs.writeFileSync(path.join(HOME, ".bash_profile"), profile);
fs.writeFileSync(path.join(HOME, ".bashrc"), profile);
for (const quiet of [".hushlogin", ".sudo_as_admin_successful"]) fs.writeFileSync(path.join(HOME, quiet), "");

const repo = path.join(HOME, "hivemind");
execFileSync("git", ["clone", "-q", "--depth", "40", `file://${ROOT}`, repo]);
execFileSync("git", ["-C", repo, "remote", "set-url", "origin", "https://github.com/dip497/hivemind.git"]);
execFileSync("git", ["-C", repo, "config", "user.email", "you@example.com"]);
execFileSync("git", ["-C", repo, "config", "user.name", "you"]);
// The clone's tests run against this checkout's installed packages.
for (const dir of [".", ...["apps", "packages"].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).map((x) => path.join(d, x)))]) {
  const nm = path.join(ROOT, dir, "node_modules");
  if (fs.existsSync(nm) && fs.existsSync(path.join(repo, dir))) fs.symlinkSync(nm, path.join(repo, dir, "node_modules"));
}

const plugins = path.join(HOME, "plugins");
// The Island view installs from its build, dist/.
for (const [from, to] of [["views/island/dist", "island"], ["widgets/ci-light", "ci-light"], ["tools/flaky-tests", "flaky-tests"]]) {
  if (!fs.existsSync(path.join(PLUGINS, from))) throw new Error(`no ${from} in ${PLUGINS}`);
  fs.cpSync(path.join(PLUGINS, from), path.join(plugins, to), { recursive: true });
}

let hcp = {};
const cli = (...a) => spawnSync(bun, [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });

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
for (const a of ["claude", "codex", "pi"]) {
  const r = cli("agents", "install", a, "--yes");
  if (r.status !== 0) throw new Error(`agents install ${a}: ${r.stdout}${r.stderr}`);
}

const app = await electron.launch({
  args: [path.join(APP, "out/main/index.js"), "--no-sandbox", `--force-device-scale-factor=${SCALE}`],
  cwd: repo, env,
});
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
  w.setBounds({ x: 0, y: 0, width: s.width, height: s.height });
}, SIZE);
await page.reload();
await page.waitForSelector(".react-flow", { timeout: 30_000 });

const userData = await (async () => {
  for (let i = 0; i < 80; i++) {
    const d = fs.readdirSync(XDG).map((x) => path.join(XDG, x)).find((x) => fs.existsSync(path.join(x, "hcp.token")));
    if (d) return d;
    await page.waitForTimeout(250);
  }
  throw new Error("the app never opened its control socket");
})();
hcp = { HIVEMIND_APP_DATA: userData, HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
// The agents' own `hive` reaches this app.
fs.writeFileSync(path.join(BIN, "hive"), `#!/usr/bin/env bash\nexport HIVEMIND_APP_DATA='${hcp.HIVEMIND_APP_DATA}' HIVE_HCP_SOCK='${hcp.HIVE_HCP_SOCK}' HCP_TOKEN='${hcp.HCP_TOKEN}'\nexec ${bun} ${CLI} "$@"\n`, { mode: 0o755 });

const wait = (ms) => page.waitForTimeout(ms);
const emit = (name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n, { detail: d })), [name, detail]);

const WORKING = {
  claude: (task) => `(i=0; while :; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r\\e[?25l%s ${task}… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done)`,
  codex: (task) => `(i=0; while :; do i=$((i+1)); printf '\\r\\e[?25l• Working (%ss) · ${task}  ' $((i*4/10)); sleep 0.4; done)`,
  pi: (task) => `(i=0; while :; do i=$((i+1)); printf '\\r\\e[?25lWorking... ${task} (%ss)  ' $((i*4/10)); sleep 0.4; done)`,
};
const agent = (name, frame, script, kind) => {
  const r = cli("ctl", "spawn", "--agent", kind, "--name", name, ...(frame ? ["--frame", frame] : []), "--prompt", script, "--json");
  if (r.status !== 0) console.error(`spawn ${name}: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout || "{}");
  return out.data?.tile ?? out.tile;
};
async function namedFrame(title) {
  await emit("hivemind:add-frame");
  await wait(800);
  const id = await page.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? null);
  await emit("hivemind:frame-rename", id);
  const input = page.locator(`.react-flow__node[data-id="${id}"] input`).first();
  if (await input.count()) { await input.fill(title); await input.press("Enter"); }
  await wait(400);
  return id;
}

// ── the scene, built before the camera runs ──────────────────────────────────
// Three frames of this repository, an agent of each kind at real work in them. Each screen is the
// real output of the command named in it, then the spinner its provider's detector reads.
for (const f of ["views", "cli", "packages"]) await namedFrame(f);
const work = (kind, cmd, task) => `clear; printf '\\e[?25l'; ${cmd} 2>&1 | head -n 16; printf '\\n'; ${WORKING[kind](task)}`;
for (const [frame, kind, name, script] of [
  ["views", "codex", "trace-glass", work("codex", "grep -rn 'effectiveGlass' apps/desktop/src --include=*.ts | cut -c1-90", "Tracing effectiveGlass")],
  ["views", "pi", "renderer-diff", work("pi", "git diff --stat HEAD~3 -- apps/desktop | tail -n 8", "Summarising the renderer diff")],
  ["cli", "claude", "ctl-history", work("claude", "git log --oneline -n 10 -- apps/cli", "Reading the ctl history")],
  ["cli", "pi", "last-commit", work("pi", "git show --stat --oneline HEAD | head -n 10", "Checking the last commit")],
  ["packages", "codex", "protocol", work("codex", "grep -rn 'PROTOCOL_VERSION' packages --include=*.ts | cut -c1-90", "Checking the protocol version")],
]) agent(name, frame, script, kind);

// The agent the person talks to. Each request it reads runs the next step: it says what it will
// do, runs the real hive commands for it, and is ready for the next one.
const steps = path.join(HOME, "steps");
fs.mkdirSync(steps, { recursive: true });
const say = (t) => `printf '\\n\\e[37m⏺\\e[0m %s\\n' "${t}"`;
/** One real command as the agent runs it, with the first lines of what it printed. */
const run = (c, lines = 2) => `printf '\\n\\e[32m⏺\\e[0m \\e[1mBash\\e[0m(%s)\\n' "${c.replace(/"/g, '\\"')}"; (${c}) 2>&1 | sed -e "s#$HOME#~#g" -e 's/;.*//' -e 's/^/  \\x1b[38;5;244m⎿  /' -e 's/$/\\x1b[0m/' | head -n ${lines}`;
const spin = (task, s) => `end=$((SECONDS+${s})); i=0; while [ $SECONDS -lt $end ]; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r\\e[?25l\\e[38;5;208m%s\\e[0m ${task}… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done; printf '\\r\\e[K'`;
const STEP = [
  [spin("Reading the views guide", 2), say("I'll add the Island view and switch to it."),
    run("hive plugins install ~/plugins/island && hive plugins enable view:@dip497/island", 1),
    // Software rendering on a recording display: the view's own settings for less drawing.
    "hive plugins set view:@dip497/island shadows false >/dev/null; hive plugins set view:@dip497/island frameRate 30 >/dev/null",
    spin("Checking the islands", 1),
    run("hive ctl plugin open view:@dip497/island", 1)],
  [spin("Reading the widgets guide", 2), say("I'll put a CI light on the board and run the build."),
    run("hive plugins install ~/plugins/ci-light && hive plugins enable widget:@dip497/ci-light", 1),
    run("hive ctl plugin open widget:@dip497/ci-light", 1),
    run(`hive ctl plugin call @dip497/ci-light set '{"state":"running","name":"CI"}'`, 0),
    spin("Running the build", 2),
    run(`hive ctl plugin call @dip497/ci-light set '{"state":"passed","name":"CI","detail":"typecheck, build and unit tests"}'`, 0)],
  [spin("Reading the tools guide", 2), say("I'll add the Flaky tests tool and open it on the canvas."),
    run("hive plugins install ~/plugins/flaky-tests && hive plugins enable tool:dip497/flaky-tests", 1),
    run(`hive plugins set tool:dip497/flaky-tests command "bun test screens" && hive plugins set tool:dip497/flaky-tests runs 3`, 0),
    run("hive ctl plugin open view:canvas && hive ctl open-tool dip497/flaky-tests/flaky", 0),
    `for i in $(seq 30); do hive ctl plugin call dip497/flaky-tests run >/dev/null 2>&1 && break; sleep 0.5; done`,
    run("hive ctl plugin call dip497/flaky-tests flaky", 3)],
];
STEP.forEach((s, i) => fs.writeFileSync(path.join(steps, `${i + 1}.sh`), `${s.join("\n")}\n`));
// It starts on the views this workspace has.
fs.writeFileSync(path.join(HOME, "lead.sh"), `${run("hive plugins list --kind view", 4)}
n=0
while :; do
  printf '\\n\\e[38;5;244m❯\\e[0m \\e[?25l'; until IFS= read -t 0.4 -r ask; do printf '\\e[?25l'; done; [ -z "$ask" ] && continue
  n=$((n+1)); [ -f ~/steps/$n.sh ] && bash ~/steps/$n.sh
done
`);
const lead = agent("my-workspace", "views", "clear; printf '\\e[?25l'; cd ~/hivemind; bash ~/lead.sh", "claude");
if (!lead) throw new Error("the lead agent did not start");

await wait(6000);
/** The pointer leaves what it clicked, so no tooltip stays in the shot. */
const rest = () => page.mouse.move(SIZE.width * 0.5, SIZE.height * 0.6);
// The camera opens on the agent the person talks to, at 100%, so its text reads on the page.
const focused = cli("ctl", "focus", lead);
if (focused.status !== 0) throw new Error(`focus ${lead}: ${focused.stdout}${focused.stderr}`);
await rest();
await wait(4000);

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
const ask = async (text) => {
  await clickTerminal();
  await page.keyboard.type(text, { delay: 45 });
  await wait(350);
  await page.keyboard.press("Enter");
  await rest();
};
/** Ask until `ok` or the time is up; each ask is a CLI start, slow on a busy machine. */
const until = async (ok, ms) => { const end = Date.now() + ms; while (Date.now() < end && !ok()) await wait(300); };
const pluginOpen = (id) => until(() => cli("ctl", "plugin", "list").stdout.includes(id), 60_000);

const PROBE = args.includes("--probe");
const beats = [];
let t0 = Date.now(), rec;
const mark = async (key) => {
  beats.push({ key, at: Math.round((Date.now() - t0) / 100) / 10 });
  if (PROBE) await page.screenshot({ path: path.join(OUT, `probe-${beats.length}-${key}.png`) });
};
if (!PROBE) {
  const W = SIZE.width * SCALE, H = SIZE.height * SCALE;
  rec = spawn("ffmpeg", [
    "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(FPS),
    "-video_size", `${W}x${H}`, "-i", `${process.env.DISPLAY}+0,0`,
    "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", path.join(OUT, "raw.mkv"),
  ], { stdio: "inherit" });
  await wait(800);
  t0 = Date.now();
}

try {
  // 1. the person asks for a view, and the app switches to it
  await mark("view");
  await wait(1000);
  await ask("Show my workspace as islands.");
  await pluginOpen("view @dip497/island");
  await mark("switched");
  await until(() => cli("ctl", "plugin", "call", "@dip497/island", "census").status === 0, 20_000);
  await mark("drawn");
  await wait(3500);
  await mark("island");
  // The island docks the agent's terminal beside it; ask again until it is on screen.
  const terminalShown = () => page.$$eval(".xterm-screen", (els) => els.some((e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true })));
  for (const end = Date.now() + 90_000; Date.now() < end && !(await terminalShown());) {
    const r = cli("ctl", "plugin", "call", "@dip497/island", "show", '{"name":"my-workspace"}');
    if (r.status !== 0) console.error(`island show: ${r.stdout}${r.stderr}`.trim());
    await wait(1500);
  }
  await wait(2500);
  // 2. a widget
  await mark("widget");
  await ask("Put a CI light where I can see it.");
  await until(() => cli("ctl", "plugin", "call", "@dip497/ci-light", "status").stdout.includes("passed"), 90_000);
  await wait(3000);
  // 3. a tool
  await mark("tool");
  await ask("Find the flaky tests.");
  await until(() => cli("ctl", "plugin", "call", "dip497/flaky-tests", "flaky").status === 0, 60_000);
  await wait(4000);
  await mark("end");
} finally {
  if (rec) { rec.kill("SIGINT"); await new Promise((r) => rec.on("close", r)); }
  await page.screenshot({ path: path.join(OUT, "poster.png") });
  fs.writeFileSync(path.join(OUT, "beats.json"), `${JSON.stringify(beats, null, 2)}\n`);
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  fs.rmSync(HOME, { recursive: true, force: true });
}
console.log(JSON.stringify(beats));
