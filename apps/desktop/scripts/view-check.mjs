// Drive a community view through real agent states in the real app, and screenshot each.
// For developing and reviewing views — not for marketing: the agents here are a `claude` shim
// whose terminal shows the screens the real status detector reads (working, permission, idle).
//
//   cd apps/desktop && xvfb-run -a -s "-screen 0 3400x2200x24" \
//     node scripts/view-check.mjs <view-id> <out-dir>
import { _electron as electron } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(APP, "../..");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const [VIEW = "queue", OUT_ARG = "view-check", PALETTE = "shipped"] = process.argv.slice(2);
const OUT = path.resolve(OUT_ARG);
const VIEWS = VIEW === "all" ? ["tiled", "board", "queue"] : [VIEW];
fs.mkdirSync(OUT, { recursive: true });

// Palette candidates, applied as the same --color-* tokens the app and every view read.
// "shipped" is the app as it installs today, for comparison.
const PALETTES = {
  shipped: null,
  // Neutral graphite. Working is near-white; the one warm colour is reserved for what needs you.
  signal: {
    css: { bg: "oklch(0.165 0.004 250)", bg2: "oklch(0.195 0.004 250)", bg3: "oklch(0.23 0.005 250)", bg4: "oklch(0.27 0.005 250)",
      fg: "oklch(0.93 0.004 250)", fg2: "oklch(0.80 0.005 250)", fg3: "oklch(0.62 0.006 250)", line: "oklch(0.27 0.005 250)", line2: "oklch(0.34 0.006 250)",
      brand: "oklch(0.88 0.01 250)", accent: "oklch(0.88 0.01 250)", warn: "oklch(0.80 0.13 72)", ok: "oklch(0.74 0.07 155)", err: "oklch(0.66 0.11 32)", info: "oklch(0.72 0.03 240)" },
    terminal: { background: "#1a1c1f", foreground: "#e6e7e9" }, wallpaper: "mono",
  },
  // Warm charcoal with honey as the working colour and coral for what needs you.
  honey: {
    css: { bg: "oklch(0.17 0.008 60)", bg2: "oklch(0.20 0.009 60)", bg3: "oklch(0.24 0.009 60)", bg4: "oklch(0.28 0.01 60)",
      fg: "oklch(0.93 0.012 80)", fg2: "oklch(0.80 0.012 80)", fg3: "oklch(0.63 0.014 75)", line: "oklch(0.28 0.01 60)", line2: "oklch(0.35 0.012 60)",
      brand: "oklch(0.82 0.12 82)", accent: "oklch(0.82 0.12 82)", warn: "oklch(0.70 0.15 38)", ok: "oklch(0.75 0.08 135)", err: "oklch(0.62 0.14 25)", info: "oklch(0.74 0.05 200)" },
    terminal: { background: "#1f1b17", foreground: "#eee7dc" }, wallpaper: "mono",
  },
};
const palette = PALETTES[PALETTE];
if (palette === undefined) throw new Error(`unknown palette ${PALETTE}: ${Object.keys(PALETTES).join(", ")}`);

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const XDG = tmp("hm-view-xdg-"), HOME = tmp("hm-view-home-"), WORK = tmp("hm-view-work-"), BIN = tmp("hm-view-bin-");

// The app types an agent's first prompt once its screen reads idle, so the shim shows the idle
// prompt, reads the line it is given, and runs it — each agent's screen is what the test asks for.
fs.writeFileSync(path.join(BIN, "claude"), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "0.0.0 (view-check shim)"; exit 0; }
printf '\\n❯ '
IFS= read -r line
clear
exec bash -c "$line" 2>>"${BIN}/stderr.txt"
`, { mode: 0o755 });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith("CLAUDE") && !["ELECTRON_RUN_AS_NODE", "ELECTRON_RENDERER_URL", "HIVE_HCP_SOCK", "HCP_TOKEN"].includes(k)));
// The PTY daemon stays on: it is where status is detected for tiles that are not on screen, and
// every real install has it. The one this run starts is stopped at the end.
Object.assign(env, { XDG_CONFIG_HOME: XDG, HOME, HIVEMIND_SHELL_ENV: "0", PATH: `${BIN}:${process.env.PATH}` });
fs.writeFileSync(path.join(HOME, ".bash_profile"), 'PS1="\\W \\$ "\n');
fs.writeFileSync(path.join(HOME, ".hushlogin"), "");

const repo = path.join(WORK, "hivemind");
execFileSync("git", ["clone", "-q", "--depth", "5", `file://${ROOT}`, repo]);
let hcp = {};
const cli = (...a) => spawnSync("bun", [CLI, ...a], { cwd: repo, encoding: "utf8", env: { ...env, ...hcp } });

if (palette) {
  for (const [k, v] of [["appearance.wallpaper.kind", palette.wallpaper], ["appearance.terminal.background", palette.terminal.background], ["appearance.terminal.foreground", palette.terminal.foreground]]) cli("config", "set", k, JSON.stringify(v));
}
for (const id of VIEWS) {
  const dir = path.join(ROOT, "examples/views", id);
  execFileSync("node", [path.join(dir, "build.mjs")], { stdio: "ignore" });
  const installed = cli("views", "install", path.join(dir, "dist"), "--json");
  if (installed.status !== 0) throw new Error(`views install ${id} failed: ${installed.stdout}${installed.stderr}`);
}

// A build elsewhere (HIVEMIND_APP_OUT) keeps a running dev app's out/ untouched.
const app = await electron.launch({ args: [path.join(APP, process.env.HIVEMIND_APP_OUT ?? "out", "main/index.js"), "--no-sandbox", "--force-device-scale-factor=2"], cwd: repo, env });
const page = await app.firstWindow();
page.on("pageerror", (e) => console.error("[renderer]", e.message));
page.on("console", (m) => { if (m.type() === "error" || /view "|\[hivemind\]/.test(m.text())) console.log(`[console:${m.type()}]`, m.text().slice(0, 240)); });
await app.evaluate(({ app: a, ipcMain, BrowserWindow }) => {
  ipcMain.removeHandler("checkForUpdate");
  ipcMain.handle("checkForUpdate", () => ({ current: a.getVersion(), latest: a.getVersion(), updateAvailable: false, ok: true }));
  const w = BrowserWindow.getAllWindows()[0];
  w.unmaximize(); w.setContentSize(1600, 1000); w.center();
});
await page.reload();
await page.waitForSelector(".react-flow", { timeout: 30_000 });
if (palette) {
  // Author !important beats the theme store's inline tokens, so the whole app — and every view
  // reading its theme — takes the candidate palette.
  const vars = Object.entries(palette.css).map(([k, v]) => `--color-${k}: ${v} !important;`).join(" ");
  await page.addStyleTag({ content: `:root, :root[data-preset], html { ${vars} }` });
  await page.evaluate(() => window.dispatchEvent(new Event("resize")));
}
for (let i = 0; i < 80 && !hcp.HCP_TOKEN; i++) {
  const d = fs.readdirSync(XDG).map((x) => path.join(XDG, x)).find((x) => fs.existsSync(path.join(x, "hcp.token")));
  if (d) hcp = { HIVE_HCP_SOCK: path.join(d, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(d, "hcp.token"), "utf8").trim() };
  else await page.waitForTimeout(250);
}

const wait = (ms) => page.waitForTimeout(ms);
const emit = (name, detail) => page.evaluate(([n, d]) => window.dispatchEvent(new CustomEvent(n, { detail: d })), [name, detail]);
let current = VIEWS[0];
const shot = async (name) => { await wait(1200); await page.screenshot({ path: path.join(OUT, `${PALETTE}-${current}-${name}.png`) }); console.log(`shot ${PALETTE}-${current}-${name}`); };

// Screens the real detector reads.
// A working agent's screen keeps moving; a still one reads as finished, as it should.
const WORKING = (task) => `(i=0; while :; do for g in ✻ ✶ ✳ ✢; do i=$((i+1)); printf '\\r%s ${task}… (%ss · esc to interrupt)  ' "$g" $((i*4/10)); sleep 0.4; done; done)`;
const PERMISSION = (file) => `printf '\\n Edit ${file}\\n\\n Do you want to make this edit to ${file}?\\n ❯ 1. Yes\\n   2. Yes, and don\\x27t ask again this session\\n   3. No, and tell Claude what to do differently\\n'`;
const IDLE = `printf '\\n❯ \\n'`;
const agent = (name, frame, script) => {
  const r = cli("ctl", "spawn", "--agent", "claude", "--name", name, ...(frame ? ["--frame", frame] : []), "--prompt", `${script}; sleep 3600`, "--json");
  if (r.status !== 0) console.error(`spawn ${name}: ${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout || "{}").data?.tileId ?? JSON.parse(r.stdout || "{}").tileId;
};

try {
  // Two named frames, made explicitly: an unknown --frame falls back to the caller's frame.
  for (const title of ["hivemind", "hivehub"]) {
    await emit("hivemind:add-frame");
    await wait(800);
    const id = await page.$$eval(".react-flow__node-frame", (els) => els.at(-1)?.getAttribute("data-id") ?? null);
    if (!id) continue;
    await emit("hivemind:frame-rename", id);
    const input = page.locator(`.react-flow__node[data-id="${id}"] input`).first();
    if (await input.count()) { await input.fill(title); await input.press("Enter"); }
    await wait(300);
  }

  agent("reviewer", "hivemind", PERMISSION("src/limits.ts"));
  agent("docs", "hivemind", IDLE);
  agent("builder", "hivemind", `(timeout 9 bash -c "${WORKING("Refactoring the rate limiter").replace(/"/g, '\\"')}"); clear; ${PERMISSION("src/buckets.ts")}`);
  agent("api", "hivehub", WORKING("Writing the publish endpoint"));
  agent("tests", "hivehub", `(timeout 5 bash -c "${WORKING("Running the suite").replace(/"/g, '\\"')}"); clear; ${IDLE}`);
  agent("migrate", "hivehub", PERMISSION("migrations/0001.sql"));
  await emit("hivemind:canvas-toggle", "shell");

  await wait(12_000);
  const listed = JSON.parse(cli("ctl", "list", "--json").stdout || "{}");
  console.log("statuses:", (listed.frames ?? []).flatMap((f) => f.tiles.map((t) => `${t.label}:${t.status}`)).join("  "));

  // Each view's own keys: the queue works the list, tiled switches frame and layout, the board reviews.
  const STEPS = {
    queue: [["n", "2-docked"], ["j", "3-next"]],
    tiled: [["2", "2-frame-two"], ["m", "3-grid"]],
    board: [["Enter", "2-review"], ["Escape", null], ["Shift+ArrowRight", "3-moved"]],
  };
  let keys;
  for (const view of VIEWS) {
    current = view;
    await emit("hivemind:set-view-mode", { mode: view });
    await page.waitForSelector(`[data-community-view="${view}"][data-community-ready="1"]`, { timeout: 20_000 });
    await wait(2500);
    await shot("1-arrive");
    // Keys go to the view's own focusable element, the way a person's would after clicking into it.
    keys = page.frame({ name: `hm-view:${view}` })?.locator('[tabindex="0"]').first();
    await keys?.focus().catch(() => {});
    for (const [key, name] of STEPS[view] ?? []) {
      await keys?.press(key).catch(() => {});
      if (name) await shot(name); else await wait(500);
      await keys?.focus().catch(() => {});
    }
  }

  if (VIEWS.at(-1) === "queue") {
    // Everyone who needed you is dealt with: the quiet state, with nothing docked.
    const all = (JSON.parse(cli("ctl", "list", "--json").stdout || "{}").frames ?? []).flatMap((f) => f.tiles);
    for (const t of all) if (t.status === "permission" || t.status === "blocked") cli("ctl", "close", t.tileId);
    await keys?.press("Escape").catch(() => {});
    await wait(3500);
    await shot("4-quiet");
  }
} finally {
  const pid = app.process().pid;
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8000))]);
  try { process.kill(pid, "SIGKILL"); } catch {}
  // Only processes whose environment carries this run's private profile: the daemon it started,
  // and the agents that daemon kept alive. Nothing of the operator's is touched.
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { if (fs.readFileSync(`/proc/${p}/environ`, "utf8").includes(`XDG_CONFIG_HOME=${XDG}`)) process.kill(Number(p), "SIGTERM"); } catch {}
  }
  for (const d of [XDG, HOME, WORK, BIN]) fs.rmSync(d, { recursive: true, force: true });
}
