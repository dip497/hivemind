// settings.json is the user's configuration and it wins everywhere (design doc
// 6b): a preset picked in Settings ▸ Appearance repaints the shell AND the
// terminals; `hive theme use` repaints a RUNNING app over HCP; and with
// `pluginSurfaces: "theme"` a tile docked inside a community scene gets the
// wallpaper painted behind its slot only — nothing full-window.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { QUEUE_DIR, dockViaQueue, queueReady } from "./helpers/queue-view";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
// Own profile (see host-chrome.spec.ts). settings.json lives at
// <XDG>/hivemind/settings.json for BOTH the app and the CLI.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;
const settingsFile = () => path.join(XDG, "hivemind", "settings.json");
const onDisk = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));

let hcpEnv: Record<string, string> = {};
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { cwd: repo, encoding: "utf8", env: { ...ENV, ...hcpEnv } });
  try { return JSON.parse(r.stdout.trim()) as { ok: boolean; data?: Record<string, unknown> }; }
  catch { throw new Error(`hive ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`); }
};

const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const preset = () => page.evaluate(() => document.documentElement.dataset.preset ?? null);
const openSettings = async (pageId: string) => {
  if (await page.locator("[data-settings-body]").count() === 0) await page.locator('[aria-label="settings"]').click();
  await page.locator(`[data-settings-page="${pageId}"]`).click();
};
const closeSettings = () => page.getByRole("button", { name: "Close", exact: true }).click();

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-settings-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
  execFileSync("bun", [CLI, "views", "install", QUEUE_DIR, "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error" && !/Content Security Policy/.test(m.text())) console.log("[r.error]", m.text()); });
  const userData = path.join(XDG, "hivemind-dev");
  const sock = path.join(userData, "hcp.sock"), tokenFile = path.join(userData, "hcp.token");
  await expect.poll(() => fs.existsSync(sock) && fs.existsSync(tokenFile), { timeout: 20_000 }).toBe(true);
  hcpEnv = { HIVE_HCP_SOCK: sock, HCP_TOKEN: fs.readFileSync(tokenFile, "utf8").trim() };
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 10_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(XDG, { recursive: true, force: true }).catch(() => {});
});

test("a preset picked in Settings repaints the shell and every terminal, and lands in settings.json", async () => {
  await toView("canvas");
  expect(await preset()).toBe("signal");
  await openSettings("appearance");
  await page.locator('[data-preset-select]').selectOption('dracula');
  expect(await preset()).toBe("dracula");
  await closeSettings();
  // The terminal palette is derived from the same appearance object.
  await expect.poll(() => page.getAttribute(".react-flow__node-terminal [data-term-bg]", "data-term-bg")).toBe("#282a36");
  await expect.poll(() => onDisk().appearance.preset, { timeout: 5_000 }).toBe("dracula");
  await expect.poll(() => onDisk().appearance.terminal.background).toBe("#282a36");
});

test("`hive theme use` repaints the running app — no restart, no reopened window", async () => {
  const r = hive("theme", "use", "nord");
  expect(r.ok).toBe(true);
  expect(r.data?.rescanned).toBe(true); // the CLI reached the app over HCP
  await expect.poll(preset, { timeout: 5_000 }).toBe("nord");
  await expect.poll(() => page.getAttribute(".react-flow__node-terminal [data-term-bg]", "data-term-bg")).toBe("#2e3440");
});

test("pluginSurfaces: an installed view shows the wallpaper behind it, and 'opaque' takes the glass off the tools docked into it", async () => {
  await toView("canvas");
  const tileId = (await page.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  await toView("queue");
  await page.waitForSelector(queueReady, { timeout: 15_000 });
  const dock = () => dockViaQueue(page, tileId);
  await dock();
  // One layer, full-window, behind the view; a slot needs no copy of its own because the
  // view's surfaces are translucent and the wallpaper already sits behind them.
  await expect(page.locator(`[data-community-slot="${tileId}"] .hm-wallpaper`)).toHaveCount(0);
  await expect(page.locator(".hm-wallpaper")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);

  await page.locator(`[data-slot-bar="${tileId}"]`).getByLabel("Undock").click();
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  await expect(page.locator(".hm-wallpaper"), "the view keeps the wallpaper it was given").toHaveCount(1);

  // "opaque" is the opt-out: the same dock has no wallpaper and no glass.
  await openSettings("appearance");
  await page.getByLabel("Tools in scene views").selectOption("opaque");
  await closeSettings();
  await dock();
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(false);
  await page.locator(`[data-slot-bar="${tileId}"]`).getByLabel("Undock").click();
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal .xterm");
});

test("a preserved terminal follows the view's opacity without another theme change", async () => {
  await toView("canvas");
  for (const [key, value] of [
    ["appearance.glass.enabled", "true"],
    ["appearance.glass.contentGlass", "true"],
    ["appearance.pluginSurfaces", JSON.stringify("opaque")],
  ]) expect(hive("config", "set", key, value).ok).toBe(true);
  const terminal = page.locator("[data-term-bg]").first();
  await expect(terminal).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  const original = await terminal.elementHandle();
  const background = onDisk().appearance.terminal.background;
  await toView("queue");
  await expect(terminal).toHaveAttribute("data-term-bg", background);
  await toView("canvas");
  await expect(terminal).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  expect(await terminal.evaluate((el, previous) => el === previous, original)).toBe(true);
  await original?.dispose();
});
