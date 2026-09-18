// Real screenshots of the real app, for the website. Nothing is mocked: the app is the built
// one, the workspace is a clone of this repository, and every tile runs a real command.
//
//   cd apps/desktop && xvfb-run -a -s "-screen 0 3400x2200x24" \
//     node scripts/site-shots.mjs <out-dir> [--wallpaper ice]
//
// The run gets its own settings profile and HOME and no PTY daemon, so it cannot attach to a
// live session, and a shell prompt shows the directory name and nothing about the machine.
import { _electron as electron } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const args = process.argv.slice(2);
const OUT = path.resolve(args[0] ?? "site-shots");
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : fallback; };
const WALLPAPER = opt("wallpaper", "mono");
const SIZE = { width: 1600, height: 1000 };

fs.mkdirSync(OUT, { recursive: true });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const XDG = tmp("hm-shots-xdg-"), HOME = tmp("hm-shots-home-"), WORK = tmp("hm-shots-work-");

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HIVE_HCP_SOCK", "HCP_TOKEN"].includes(k)));
Object.assign(env, { XDG_CONFIG_HOME: XDG, HOME, HIVEMIND_SHELL_ENV: "0", HIVEMIND_PTY_DAEMON: "0" });

// Tiles start login shells, which read .bash_profile — not .bashrc.
const profile = 'PS1="\\[\\e[38;5;244m\\]\\W\\[\\e[0m\\] \\$ "\nexport GIT_PAGER=cat PAGER=cat LESS=FRX\n';
fs.writeFileSync(path.join(HOME, ".bash_profile"), profile);
fs.writeFileSync(path.join(HOME, ".bashrc"), profile);
for (const quiet of [".hushlogin", ".sudo_as_admin_successful"]) fs.writeFileSync(path.join(HOME, quiet), "");

const repo = path.join(WORK, "hivemind");
execFileSync("git", ["clone", "-q", "--depth", "40", `file://${ROOT}`, repo]);
// The second frame is a second real project, beside this one.
const HIVEHUB = path.resolve(ROOT, "../hivehub");
if (fs.existsSync(path.join(HIVEHUB, ".git"))) execFileSync("git", ["clone", "-q", `file://${HIVEHUB}`, path.join(WORK, "hivehub")]);
const MODE = opt("mode", "dark");
execFileSync("git", ["-C", repo, "config", "user.email", "site@hivemind.dev"]);
execFileSync("git", ["-C", repo, "config", "user.name", "hivemind"]);
// A real change for the diff tile to show: this branch's own changelog, as it stands.
const change = spawnSync("git", ["-C", ROOT, "diff", "HEAD", "--", "CHANGELOG.md"], { encoding: "utf8" }).stdout;
if (change) spawnSync("git", ["-C", repo, "apply", "-"], { input: change });

const cli = (...a) => spawnSync("bun", [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });
let hcp = {};

// Appearance goes into the profile before launch; set on a running app it would reload it.
for (const [k, v] of [
  ["appearance.mode", MODE],
  ["appearance.glass.enabled", true],
  ["appearance.glass.contentGlass", true],
  ["appearance.glass.opacity", Number(opt("panel", 0.82))],
  ["appearance.glass.contentOpacity", Number(opt("content", 0.57))],
  ["appearance.glass.blur", Number(opt("blur", 22))],
  ["appearance.wallpaper.kind", opt("image", null) ? "image" : WALLPAPER],
  ["appearance.terminal.background", "#121416"],
]) cli("config", "set", k, JSON.stringify(v));
// The example views, so a shot can show the workspace drawn by a plugin.
const VIEWS = ["queue", "tiled", "board"];
for (const id of VIEWS) {
  const dir = path.join(ROOT, "examples/views", id);
  execFileSync("node", [path.join(dir, "build.mjs")], { stdio: "ignore" });
  cli("views", "install", path.join(dir, "dist"));
}

const app = await electron.launch({
  args: [path.join(APP, "out/main/index.js"), "--no-sandbox", "--force-device-scale-factor=2"],
  cwd: repo, env,
});
const page = await app.firstWindow();
page.on("pageerror", (e) => console.error("[renderer]", e.message));

// A marketing screenshot is not the place for an update banner: answer the check as current.
await app.evaluate(({ app: a, ipcMain }) => {
  ipcMain.removeHandler("checkForUpdate");
  ipcMain.handle("checkForUpdate", () => ({ current: a.getVersion(), latest: a.getVersion(), updateAvailable: false, ok: true }));
});
// No window manager under xvfb, so a maximised window ignores a resize: take the screen instead.
const shotSize = await app.evaluate(({ BrowserWindow, screen }, s) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize();
  w.setBounds({ x: 0, y: 0, width: s.width, height: s.height });
  const got = w.getContentSize();
  return { asked: [s.width, s.height], got, screen: screen.getPrimaryDisplay().size };
}, SIZE);
console.log("window", JSON.stringify(shotSize));
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

// A still wallpaper, imported the way the app's own picker does it.
const IMAGE = opt("image", null);
if (IMAGE) {
  const media = path.join(userData, "media");
  fs.mkdirSync(media, { recursive: true });
  const name = `background-${Date.now()}${path.extname(IMAGE) || ".jpg"}`;
  fs.copyFileSync(path.resolve(IMAGE), path.join(media, name));
  cli("config", "set", "appearance.wallpaper.imageSrc", JSON.stringify(`hivemedia://media/${name}`));
  cli("config", "set", "appearance.wallpaper.brightness", JSON.stringify(Number(opt("brightness", 0.45))));
  await page.reload();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

const wait = (ms) => page.waitForTimeout(ms);
const emit = (name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n, { detail: d })), [name, detail]);
// Shells are not agents, so the control plane does not list them; the canvas does.
const terminalIds = () => page.$$eval(".react-flow__node-terminal", (els) => els.map((e) => e.getAttribute("data-id")));

/** Open a shell, wait for it, and type a real command into it. */
async function shell(frameId, command) {
  const before = new Set(await terminalIds());
  if (frameId) await emit("hivemind:frame-open", { frameId, kind: "shell" });
  else await emit("hivemind:canvas-toggle", "shell");
  let id;
  for (let i = 0; i < 60 && !id; i++) { await wait(200); id = (await terminalIds()).find((t) => !before.has(t)); }
  if (!id) throw new Error(`no shell appeared for: ${command}`);
  await page.locator(`.react-flow__node[data-id="${id}"] .xterm`).waitFor({ timeout: 10_000 });
  await wait(900);
  await page.locator(`.react-flow__node[data-id="${id}"] .xterm-helper-textarea`).focus();
  await page.keyboard.type(`clear; ${command}\n`, { delay: 3 });
  return id;
}

async function renameFrame(frameId, title) {
  await emit("hivemind:frame-rename", frameId);
  const input = page.locator(`[data-frame-rename], .react-flow__node[data-id="${frameId}"] input`).first();
  if (await input.count()) { await input.fill(title); await input.press("Enter"); }
}

const island = (title) => page.locator(`button[title^="${title}"]`).first();
const fit = async () => { await island("Fit to view").click(); await wait(700); };
/** What the canvas reports it is showing — a shot composed off-screen has no other witness. */
const zoomNow = () => page.locator(".react-flow__panel, [data-zoom-readout]").first()
  .textContent().then((t) => (t ?? "").match(/\d+%/)?.[0] ?? "?").catch(() => "?");
/** Where the tiles actually are. Fitting then zooming in pushes them back off frame, so a shot
    that means to show the work has to be told where the work ended up. */
const tilesBox = () => page.evaluate(() => {
  const els = [...document.querySelectorAll(".react-flow__node-terminal, .react-flow__node-diff, .react-flow__node-editor")];
  if (!els.length) return null;
  const r = els.map((e) => e.getBoundingClientRect());
  const box = {
    x: Math.min(...r.map((b) => b.left)), y: Math.min(...r.map((b) => b.top)),
    right: Math.max(...r.map((b) => b.right)), bottom: Math.max(...r.map((b) => b.bottom)),
  };
  return { ...box, width: box.right - box.x, height: box.bottom - box.y, count: els.length };
});
/** Fit everything, then step in only as far as the tiles stay inside the frame. */
const readable = async (steps) => {
  await fit();
  for (let i = 0; i < steps; i++) {
    await island("Zoom in").click();
    await wait(260);
    const b = await tilesBox();
    // One step too far is the step that pushes a tile off the edge: take it back and stop.
    if (b && (b.x < 8 || b.y < 8 || b.right > SIZE.width - 8 || b.bottom > SIZE.height - 8)) {
      await island("Zoom out").click();
      await wait(260);
      break;
    }
  }
  await wait(500);
  console.log(`  canvas at ${await zoomNow()}`);
};
const shot = async (name) => {
  await wait(1400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const b = await tilesBox();
  const vw = SIZE.width, vh = SIZE.height;
  const onscreen = b && b.x > -40 && b.y > -40 && b.right < vw + 40 && b.bottom < vh + 40;
  console.log(`shot ${name}${b ? ` — ${b.count} tiles, ${onscreen ? "all in frame" : "SOME OFF FRAME"}` : ""}`);
};

try {
  // ── a real workspace: two frames of real work in this repository ─────────────
  // Commands that run in a bare clone: nothing here needs the clone to have node_modules.
  await shell(null, "hive ctl --help");
  await shell(null, "git log --oneline --decorate=no -n 14");
  await emit("hivemind:canvas-toggle", "diff");
  await wait(1500);

  await emit("hivemind:add-frame");
  await wait(900);
  const second = await page.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? null);
  if (second && fs.existsSync(path.join(WORK, "hivehub"))) {
    await shell(second, "cd ../hivehub && node --test 'tests/*.test.ts' 2>&1 | tail -n 12");
    await renameFrame(second, "hivehub");
  }
  await wait(4000);
  await readable(Number(opt("zoom", "3")));
  await shot(`canvas-${MODE}`);

  await emit("hivemind:set-view-mode", { mode: "windows" });
  await shot(`windows-${MODE}`);

  for (const id of VIEWS) {
    await emit("hivemind:set-view-mode", { mode: id });
    await page.waitForSelector(`[data-community-view="${id}"][data-community-ready="1"]`, { timeout: 15_000 }).catch(() => {});
    await shot(`${id}-${MODE}`);
  }
} finally {
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (const d of [XDG, HOME, WORK]) fs.rmSync(d, { recursive: true, force: true });
}
