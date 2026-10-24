// A terminal program that asks to hear when the background goes light or dark (mode 2031, as Claude
// Code does) hears it when the look changes; after the window reloads, which keeps no state of its
// own (the daemon's replay teaches it the mode); and after the session's program ends and Enter
// starts a new one in the same tile.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyPreset, DEFAULT_SETTINGS, PRESETS } from "@hivemind/core/settings-schema";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

test.use({ trace: "off" });

const APP_DIR = process.cwd();
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themenotify-xdg-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themenotify-repo-"));
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themenotify-bin-"));
/** What the program read, raw: the terminal's reports among it. */
const LOG = path.join(BIN, "read");
const PROBE = path.join(BIN, "probe.js");
// It turns mode 2031 on, writes down everything it reads, and ends on "q".
fs.writeFileSync(PROBE, `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(LOG)}, "start\\n");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[?2031hprobe ready\\r\\n");
process.stdin.on("data", (d) => {
  const s = d.toString("latin1");
  fs.appendFileSync(${JSON.stringify(LOG)}, s);
  if (s.includes("q")) process.exit(0);
});
`);
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete ENV.ELECTRON_RUN_AS_NODE;

const LIGHT = "\x1b[?997;2n";
const DARK = "\x1b[?997;1n";
const read = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "latin1") : "");
/** What the program read after `from` characters of its log. */
const since = (from: number) => read().slice(from);
const starts = () => read().split("start\n").length - 1;

let app: ElectronApplication;
let page: Page;

async function typeInTerminal(text: string): Promise<void> {
  // An unselected tile takes the first click itself (it selects it); the next reaches the terminal.
  const tile = page.locator(".react-flow__node-terminal").first();
  if (!(await tile.locator(".hm-node-selected").count())) await tile.click();
  await tile.locator(".xterm").click();
  await page.keyboard.type(text);
}

/** Start the probe at the shell's prompt and wait until it has turned 2031 on. */
async function startProbe(): Promise<void> {
  const before = starts();
  await expect(async () => {
    await typeInTerminal(`node ${PROBE}\r`);
    await expect.poll(starts, { timeout: 5_000 }).toBeGreaterThan(before);
  }).toPass({ timeout: 30_000 });
}

/** Switch the look the way `hive theme use` does (the preset's paths in settings.json), through the
 *  app's own settings, with the terminal mounted: Settings, which may remount it, stays shut. */
async function choosePreset(id: string): Promise<void> {
  const cur = JSON.parse(fs.readFileSync(path.join(XDG, "hivemind", "settings.json"), "utf8")).appearance;
  const next = applyPreset({ ...DEFAULT_SETTINGS.appearance, ...cur }, PRESETS[id]!);
  for (const k of ["preset", "mode", "palette", "accent", "terminal"] as const) {
    await page.evaluate(([p, v]) => window.hive.settingsSet(p as string, v), [`appearance.${k}`, next[k]] as const);
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.themeMode)).toBe(PRESETS[id]!.mode);
}

/** Give the terminals `id`'s colours only: the app's mode stays, and so does the mounted terminal. */
async function chooseTerminal(id: string): Promise<void> {
  await page.evaluate((v) => window.hive.settingsSet("appearance.terminal", v), PRESETS[id]!.terminal);
}

async function openWindow(): Promise<void> {
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 20_000 });
}

test.beforeAll(async () => {
  seedAgents(XDG);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await openWindow();
});

test.afterAll(async () => {
  await app?.close();
  stopDaemons(XDG);
  for (const d of [XDG, repo, BIN]) fs.rmSync(d, { recursive: true, force: true });
});

test("a program that turned on mode 2031 hears the look go light, and dark again after the window reloads", async () => {
  await startProbe();
  let from = read().length;
  await choosePreset("clean-light");
  await expect.poll(() => since(from)).toContain(LIGHT);

  // A reload keeps nothing of the window's: the session's replay says the program asked.
  await page.reload();
  await openWindow();
  from = read().length;
  await choosePreset("signal");
  await expect.poll(() => since(from)).toContain(DARK);
  await typeInTerminal("q");
});

test("after the session's program ends and Enter starts another, the new one that asks hears the change", async () => {
  await startProbe();
  await typeInTerminal("q");
  await typeInTerminal("exit\r");
  // The shell ended: the tile says "press Enter to restart", and the Enter that ends the probe's
  // command line below starts a new shell (startProbe types it again until the probe runs).
  await startProbe();
  const from = read().length;
  // Only the terminal's background: the tile stays mounted, so the report is the restarted
  // session's own, from the terminal the tile kept.
  await chooseTerminal("clean-light");
  await expect.poll(() => since(from)).toContain(LIGHT);
  // Told once: the app's answer is the only one (xterm's own, which reads a glass terminal as dark, is off).
  await page.waitForTimeout(1_000);
  expect(since(from).split(LIGHT).length - 1).toBe(1);
});
