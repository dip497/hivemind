// A screen recording of the real app, for the website's hero. Same setup as site-shots.mjs —
// own profile, own HOME, no PTY daemon, a clone of this repository — and ffmpeg records the
// X display it runs on, so what lands in the file is the app itself, not a re-enactment.
//
//   cd apps/desktop && xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/site-clip.mjs <out-dir>
//
// Out: clip.webm (VP9) + clip.mp4 (H.264) + poster.png, all at the recorded size.
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
const SIZE = { width: Number(opt("width", 1600)), height: Number(opt("height", 1000)) };
const FPS = Number(opt("fps", 30));

fs.mkdirSync(OUT, { recursive: true });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const XDG = tmp("hm-clip-xdg-"), HOME = tmp("hm-clip-home-"), WORK = tmp("hm-clip-work-"), BIN = tmp("hm-clip-bin-");

// Queue and Board draw agents, so the clip needs agent tiles. The CLI they run is a stand-in that
// prints the screens the real status detector reads — the statuses, views and docking are real.
// One stand-in per bundled agent, so a shot can show the workspace holding several different
// ones rather than the same CLI three times.
for (const cli of ["claude", "codex", "pi"]) {
  // A prompt reaches a real CLI either as argv or typed at its prompt — each manifest says which
  // (pi and claude take argv, codex is typed). A stand-in that only reads stdin leaves every
  // argv agent sitting at an empty prompt, which the detector correctly calls idle.
  fs.writeFileSync(path.join(BIN, cli), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "0.0.0 (clip stand-in)"; exit 0; }
cmd=""
for a in "$@"; do case "$a" in -*) ;; *) cmd="$a" ;; esac; done
if [ -n "$cmd" ]; then clear; exec bash -c "$cmd"; fi
printf '\\n❯ '
IFS= read -r line
clear
exec bash -c "$line"
`, { mode: 0o755 });
}

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HIVE_HCP_SOCK", "HCP_TOKEN"].includes(k)));
Object.assign(env, { XDG_CONFIG_HOME: XDG, HOME, HIVEMIND_SHELL_ENV: "0", PATH: `${BIN}:${process.env.PATH}` });

const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
fs.writeFileSync(path.join(HOME, ".bash_profile"), profile);
fs.writeFileSync(path.join(HOME, ".bashrc"), profile);
for (const quiet of [".hushlogin", ".sudo_as_admin_successful"]) fs.writeFileSync(path.join(HOME, quiet), "");

const repo = path.join(WORK, "hivemind");
execFileSync("git", ["clone", "-q", "--depth", "40", `file://${ROOT}`, repo]);
execFileSync("git", ["-C", repo, "config", "user.email", "site@hivemind.dev"]);
execFileSync("git", ["-C", repo, "config", "user.name", "hivemind"]);
const change = spawnSync("git", ["-C", ROOT, "diff", "HEAD", "--", "CHANGELOG.md"], { encoding: "utf8" }).stdout;
if (change) spawnSync("git", ["-C", repo, "apply", "-"], { input: change });

let hcp = {};
const cli = (...a) => spawnSync("bun", [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });

for (const [k, v] of [
  ["appearance.mode", "dark"],
  ["appearance.glass.enabled", true],
  ["appearance.glass.contentGlass", true],
  ["appearance.glass.opacity", Number(opt("panel", 0.82))],
  ["appearance.glass.contentOpacity", Number(opt("content", 0.57))],
  ["appearance.glass.blur", Number(opt("blur", 22))],
  ["appearance.wallpaper.kind", opt("video", null) ? "video" : opt("wallpaper", "mono")],
  ["appearance.terminal.background", "#121416"],
]) cli("config", "set", k, JSON.stringify(v));

// The views the clip switches between, installed from HiveHub as anyone would.
const VIEWS = ["queue", "tiled", "board"];
const published = (name) => VIEWS.includes(name) ? `@dip497/${name}` : name;
for (const id of VIEWS) cli("views", "install", published(id));

// Stills are for the website, where they are shown at up to 1200 CSS px: capture at 2x so the
// text in a tile survives the downscale.
const STILL = opt("still", null);
const app = await electron.launch({
  args: [path.join(APP, "out/main/index.js"), "--no-sandbox", ...(STILL ? ["--force-device-scale-factor=2"] : [])],
  cwd: repo, env,
});
const page = await app.firstWindow();
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
hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };

// A video wallpaper, imported the way the app's own picker does: copied into the profile's media
// directory and addressed by hivemedia://. It is scaled to the window first — a 4K source costs
// far more to decode than the window can show, and under software rendering that drops frames.
const VIDEO = opt("video", null), IMAGE = opt("image", null);
if (IMAGE) {
  // A still wallpaper, imported the way the app's picker does it.
  const media = path.join(userData, "media");
  fs.mkdirSync(media, { recursive: true });
  const name = `background-${Date.now()}${path.extname(IMAGE) || ".jpg"}`;
  fs.copyFileSync(path.resolve(IMAGE), path.join(media, name));
  cli("config", "set", "appearance.wallpaper.kind", JSON.stringify("image"));
  cli("config", "set", "appearance.wallpaper.imageSrc", JSON.stringify(`hivemedia://media/${name}`));
  cli("config", "set", "appearance.wallpaper.brightness", JSON.stringify(Number(opt("brightness", 0.55))));
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(2000);
}
if (VIDEO) {
  const media = path.join(userData, "media");
  fs.mkdirSync(media, { recursive: true });
  const name = `background-${Date.now()}.mp4`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", path.resolve(VIDEO),
    "-vf", `scale=${SIZE.width}:-2`, "-c:v", "libx264", "-crf", "24", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-an", path.join(media, name)]);
  cli("config", "set", "appearance.wallpaper.videoSrc", JSON.stringify(`hivemedia://media/${name}`));
  cli("config", "set", "appearance.wallpaper.brightness", JSON.stringify(Number(opt("brightness", 0.6))));
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(2500);
}

const wait = (ms) => page.waitForTimeout(ms);
const emit = (name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n, { detail: d })), [name, detail]);
const terminalIds = () => page.$$eval(".react-flow__node-terminal", (els) => els.map((e) => e.getAttribute("data-id")));
const island = (title) => page.locator(`button[title^="${title}"]`).first();

async function shell(frameId, command) {
  const before = new Set(await terminalIds());
  if (frameId) await emit("hivemind:frame-open", { frameId, kind: "shell" });
  else await emit("hivemind:canvas-toggle", "shell");
  let id;
  for (let i = 0; i < 60 && !id; i++) { await wait(200); id = (await terminalIds()).find((t) => !before.has(t)); }
  if (!id) throw new Error(`no shell appeared for: ${command}`);
  await page.locator(`.react-flow__node[data-id="${id}"] .xterm`).waitFor({ timeout: 10_000 });
  await wait(700);
  await page.locator(`.react-flow__node[data-id="${id}"] .xterm-helper-textarea`).focus();
  return id;
}
/** Type into a tile at reading speed: the clip should look like someone working, not a macro. */
async function type(id, text) {
  await page.locator(`.react-flow__node[data-id="${id}"] .xterm-helper-textarea`).focus();
  await page.keyboard.type(text, { delay: 55 });
  await page.keyboard.press("Enter");
}
const toView = async (name, ready) => {
  const mode = published(name);
  await emit("hivemind:set-view-mode", { mode });
  if (ready) await page.waitForSelector(`[data-community-view="${mode}"][data-community-ready="1"]`, { timeout: 15_000 }).catch(() => {});
  await wait(1400);
};

// The screens the real status detector reads — and each provider reads its own. A single generic
// spinner leaves pi idle (it looks for the literal "Working...") and codex unblocked, so every
// stand-in prints what its own manifest in packages/hive-agents/manifests looks for.
const WORKING = {
  claude: (task) => `(i=0; while :; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r%s ${task}… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done)`,
  codex: (task) => `(i=0; while :; do i=$((i+1)); printf '\\r• Working (%ss) · ${task}  ' $((i*4/10)); sleep 0.4; done)`,
  pi: (task) => `(i=0; while :; do i=$((i+1)); printf '\\rWorking... ${task} (%ss)  ' $((i*4/10)); sleep 0.4; done)`,
};
// pi is absent on purpose: its manifest declares blockedDetection false — it never asks.
const BLOCKED = {
  claude: (file, then) => `printf '\\n Edit ${file}\\n\\n Do you want to make this edit to ${file}?\\n ❯ 1. Yes\\n   2. Yes, and don\\x27t ask again this session\\n   3. No, and tell Claude what to do differently\\n'; IFS= read -r _ans; clear; ${then}`,
  codex: (cmd, then) => `printf '\\n  $ ${cmd}\\n\\n  Allow command? [y/n] '; IFS= read -r _ans; clear; ${then}`,
};
const agent = (name, frame, script, kind = "claude") => {
  const r = cli("ctl", "spawn", "--agent", kind, "--name", name, ...(frame ? ["--frame", frame] : []), "--prompt", `${script}; sleep 3600`, "--json");
  if (r.status !== 0) console.error(`spawn ${name}: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout || "{}").data?.tileId;
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
// docs/design/demo-scene-2026-09-18.md is the spec: twenty agents across five frames of one
// real repository, three of them waiting on a person. Every screen below is real output of the
// command named in it — the shim and the permission prompt are the only stand-ins.
const FRAMES = ["views", "cli", "packages", "docs", "site"];
const frameIds = {};
for (const f of FRAMES) frameIds[f] = await namedFrame(f);

/** Real output first, then the spinner the provider's own detector reads. */
const work = (kind, cmd, task) => `clear; ${cmd} 2>&1 | head -n 22; printf '\\n'; ${WORKING[kind](task)}`;
/** The last commit that touched the file, then the question about editing it. */
const ask = (file, task) =>
  `clear; git log -p -n 1 --format='commit %h  %s' -- ${file} 2>&1 | head -n 18; ` +
  BLOCKED.claude(file, WORKING.claude(task));

const SCENE = [
  // frame, kind, script
  ["views", "claude", ask("apps/desktop/src/renderer/src/theme-store.ts", "Editing theme-store.ts")],
  ["views", "claude", work("claude", "git log --oneline --decorate=no -n 14", "Reading the view registry")],
  ["views", "codex", work("codex", "grep -rn 'effectiveGlass' apps/desktop/src --include=*.ts", "Tracing effectiveGlass")],
  ["views", "pi", work("pi", "git diff --stat HEAD~3 -- apps/desktop", "Summarising the renderer diff")],

  ["cli", "claude", ask("apps/cli/src/commands/ctl.ts", "Editing ctl.ts")],
  ["cli", "claude", work("claude", "git log --oneline -n 12 -- apps/cli", "Reading the ctl history")],
  ["cli", "pi", work("pi", "git show --stat --oneline HEAD", "Checking the last commit")],

  ["packages", "codex", `clear; git log --oneline -n 8 -- packages 2>&1 | head -n 12; ` +
    BLOCKED.codex("pnpm --filter @hivemind/desktop test:unit", WORKING.codex("Running the unit tests"))],
  ["packages", "codex", work("codex", "grep -rn 'PROTOCOL_VERSION' packages --include=*.ts", "Checking the protocol version")],
  ["packages", "pi", work("pi", "ls apps/desktop/src/renderer/src/workspace/views", "Reading the built-in views")],

  ["docs", "claude", work("claude", "find docs/src/content -name '*.md' | sort", "Drafting the upgrade note")],
  ["docs", "claude", work("claude", "sed -n '1,22p' CHANGELOG.md", "Reading the changelog")],
  ["docs", "codex", work("codex", "git log --oneline -n 10 -- docs", "Checking what changed in docs")],

  ["site", "claude", work("claude", "wc -l apps/desktop/src/renderer/src/*.tsx | sort -n | tail -12", "Measuring the renderer")],
  ["site", "pi", work("pi", "git branch -a", "Listing the branches")],
  // One that has finished: Board needs something in its Done column, and it says what it did.
  ["site", "codex", `clear; git show --stat --oneline HEAD 2>&1 | head -n 12; printf '\\nDone.\\n'`],
];
const tiles = SCENE.map(([frame, kind, script]) => ({ frame, kind, id: agent(kind, frame, script, kind) }));
// The first agent scripted to ask for permission: Queue docks whatever is selected, and a
// keypress cannot reach a view that renders in its own sandboxed frame.
const waiting = tiles[0];
await wait(6000);

const first = await shell(frameIds.views, "");
await type(first, "clear; git log --oneline --decorate=no -n 10");
await wait(1500);

// What the detector actually made of the scene. A shot of an idle workspace sells nothing, and
// the last one shipped saying "No agents yet" — so the scene reports itself before the camera.
const census = () => {
  const r = cli("ctl", "list", "--json");
  let rows = [];
  try { const d = JSON.parse(r.stdout || "{}").data; rows = Array.isArray(d) ? d : d?.tiles ?? []; } catch { /* reported below */ }
  const by = {};
  for (const t of rows) by[t.status ?? "?"] = (by[t.status ?? "?"] ?? 0) + 1;
  return { rows, by };
};
for (let i = 0; i < 20; i++) {
  const { rows, by } = census();
  const blocked = (by.blocked ?? 0) + (by.permission ?? 0);
  if (blocked >= 1 && (by.working ?? 0) >= 2) { console.log(`scene: ${rows.length} tiles — ${JSON.stringify(by)}`); break; }
  if (i === 19) console.log(`scene NOT LOADED: ${rows.length} tiles — ${JSON.stringify(by)}`);
  await wait(1000);
}
await island("Fit to view").click();
await wait(600);
await island("Zoom in").click();
await wait(1200);

// ── stills ───────────────────────────────────────────────────────────────────
// The same populated scene the clip records, held still. The view screenshots on the website
// came from a script that only opened shells, so Queue advertised itself with "No agents yet".
if (STILL) {
  const dir = path.resolve(STILL);
  fs.mkdirSync(dir, { recursive: true });
  for (const [mode, ready] of [["canvas", false], ["queue", true], ["tiled", true], ["board", true]]) {
    await toView(mode, ready);
    // Queue docks the SELECTED agent's terminal; with nothing selected it draws its empty state,
    // so the shot would miss the one thing the view exists to do. N is "next that needs you".
    if (mode === "queue" && waiting?.id) { cli("ctl", "focus", waiting.id); await wait(1800); }
    await wait(1200);
    await page.screenshot({ path: path.join(dir, `view-${mode}.png`) });
    const empty = await page.evaluate(() =>
      ["No agents yet", "Nothing needs you"].filter((s) => document.body.innerText.includes(s)));
    console.log(`still view-${mode}${empty.length ? `  — WEAK: view says ${JSON.stringify(empty)}` : ""}`);
  }
  await app.close();
  process.exit(0);
}

// ── record ───────────────────────────────────────────────────────────────────
const raw = path.join(OUT, "raw.mkv");
const rec = spawn("ffmpeg", [
  "-loglevel", "error", "-y", "-f", "x11grab", "-framerate", String(FPS),
  "-video_size", `${SIZE.width}x${SIZE.height}`, "-i", `${process.env.DISPLAY}+0,0`,
  "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", raw,
], { stdio: "inherit" });
await wait(1200);

try {
  // 1. work lands in a tile, on the canvas
  const third = await shell(frameIds.docs, "");
  await type(third, "clear; git diff --stat HEAD~4..HEAD | tail -n 12");
  await wait(2400);

  // 2. the same tiles, drawn by three installed views
  await toView("tiled", true);
  await wait(2200);
  await toView("queue", true);
  await wait(1600);
  // Queue docks a live terminal beside its list: click the row, as a person would.
  const frame = page.frameLocator(`[data-community-view="${published("queue")}"] iframe`);
  const other = frame.locator('.q-group[data-group="other"]');
  if ((await other.count()) && (await other.getAttribute("data-collapsed")) !== null) await other.locator("h2").click().catch(() => {});
  await wait(900);
  await frame.locator(".q-row").first().click({ timeout: 4000 }).catch(() => {});
  await page.waitForSelector("[data-community-slot] .xterm", { timeout: 8000 }).catch(() => {});
  await wait(2200);

  // The beat the product is about: the one that needs you is answered, and it goes back to work.
  await page.locator("[data-community-slot] .xterm-helper-textarea").first().focus().catch(() => {});
  await page.keyboard.type("1", { delay: 90 });
  await wait(700);
  await page.keyboard.press("Enter");
  await wait(2600);

  await toView("board", true);
  await wait(2400);

  // 3. back where it started
  await toView("canvas");
  await wait(1800);
} finally {
  rec.kill("SIGINT");
  await new Promise((r) => rec.on("close", r));
  await page.screenshot({ path: path.join(OUT, "poster.png") });
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (const d of [XDG, HOME, WORK]) fs.rmSync(d, { recursive: true, force: true });
}

// ── encode ───────────────────────────────────────────────────────────────────
const enc = (a) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", raw, ...a], { stdio: "inherit" });
const W = Number(opt("out-width", 1280));
enc(["-vf", `scale=${W}:-2`, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", "-an", path.join(OUT, "clip.webm")]);
enc(["-vf", `scale=${W}:-2`, "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-movflags", "+faststart", "-pix_fmt", "yuv420p", "-an", path.join(OUT, "clip.mp4")]);
fs.rmSync(raw, { force: true });
for (const f of ["clip.webm", "clip.mp4", "poster.png"]) console.log(f, `${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`);
