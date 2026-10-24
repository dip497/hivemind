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
import { TILE_LIST_DIR, dockFromList, tileListReady } from "./helpers/tile-list-view";
import { seedAgents } from "./helpers/agents";
import { pick } from "./helpers/select";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
// Own profile (see host-chrome.spec.ts). settings.json lives at
// <XDG>/hivemind/settings.json for BOTH the app and the CLI.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-settings-xdg-"));
seedAgents(XDG);
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;
const settingsFile = () => path.join(XDG, "hivemind", "settings.json");
const onDisk = () => JSON.parse(fs.readFileSync(settingsFile(), "utf8"));

let hcpEnv: Record<string, string> = {};
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { cwd: repo, encoding: "utf8", env: { ...ENV, ...hcpEnv } });
  if (r.status !== 0) throw new Error(`hive ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
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
  execFileSync("bun", [CLI, "plugins", "install", TILE_LIST_DIR, "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error" && !/Content Security Policy/.test(m.text())) console.log("[r.error]", m.text()); });
  const userData = path.join(XDG, "hivemind-dev");
  const sock = path.join(userData, "hcp.sock"), tokenFile = path.join(userData, "hcp.token");
  await expect.poll(() => fs.existsSync(sock) && fs.existsSync(tokenFile), { timeout: 20_000 }).toBe(true);
  hcpEnv = { HIVEMIND_APP_DATA: userData };
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
  await page.locator('[data-preset-select]').click();
  await page.locator('[data-preset-option="dracula"]').click();
  expect(await preset()).toBe("dracula");
  await closeSettings();
  // The terminal palette is derived from the same appearance object.
  await expect.poll(() => page.getAttribute(".react-flow__node-terminal [data-term-bg]", "data-term-bg")).toBe("#282a36");
  await expect.poll(() => onDisk().appearance.preset, { timeout: 5_000 }).toBe("dracula");
  await expect.poll(() => onDisk().appearance.terminal.background).toBe("#282a36");
});

test("`hive theme use` repaints the running app — no restart, no reopened window", async () => {
  const r = hive("theme", "use", "nord");
  expect(r.rescanned).toBe(true); // the CLI reached the app over HCP
  await expect.poll(preset, { timeout: 5_000 }).toBe("nord");
  await expect.poll(() => page.getAttribute(".react-flow__node-terminal [data-term-bg]", "data-term-bg")).toBe("#2e3440");
});

test("pluginSurfaces: an installed view shows the wallpaper behind it, and 'opaque' takes the glass off the tools docked into it", async () => {
  await toView("canvas");
  const tileId = (await page.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  await toView("tile-list");
  await page.waitForSelector(tileListReady, { timeout: 15_000 });
  const dock = () => dockFromList(page, tileId);
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
  await pick(page.getByLabel("Tools in scene views"), "Opaque");
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
  ]) expect(hive("config", "set", key, value).value).toEqual(JSON.parse(value));
  const terminal = page.locator("[data-term-bg]").first();
  await expect(terminal).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  const original = await terminal.elementHandle();
  const background = onDisk().appearance.terminal.background;
  await toView("tile-list");
  await expect(terminal).toHaveAttribute("data-term-bg", background);
  await toView("canvas");
  await expect(terminal).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  expect(await terminal.evaluate((el, previous) => el === previous, original)).toBe(true);
  await original?.dispose();
});

test("Copy JSON copies the look without the wallpaper's picture, and says so; Import… of that file keeps your picture, and of a file that is no theme changes nothing", async () => {
  // A wallpaper picked before the media picker: its address names the home folder.
  const picture = "hm-media://v/%2Fhome%2Falice%2Fcat.png";
  hive("config", "set", "appearance.wallpaper", JSON.stringify({ kind: "image", imageSrc: picture, brightness: 0.8 }));
  await expect(page.locator(".hm-wp-image")).toHaveCount(1);
  await openSettings("appearance");
  await page.getByRole("button", { name: "Copy JSON" }).click();
  await expect(page.getByText("Left out the wallpaper picture")).toBeVisible();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect([JSON.parse(copied).wallpaper, copied.includes("alice")]).toEqual([{ kind: "image", brightness: 0.8 }, false]);
  // The file back, with other corners: the look changes and the picture stays.
  const file = JSON.stringify({ ...JSON.parse(copied), radius: 3 });
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({ name: "theme.json", mimeType: "application/json", buffer: Buffer.from(file) });
  await expect(page.getByText("Imported theme.json")).toBeVisible();
  await expect.poll(() => onDisk().appearance.radius, { timeout: 5_000 }).toBe(3);
  expect(onDisk().appearance.wallpaper).toEqual({ kind: "image", imageSrc: picture, brightness: 0.8 });
  await expect(page.locator(".hm-wp-image")).toHaveCount(1);
  // A package.json picked by mistake sets nothing of the look: refused, and the look stays.
  const before = onDisk().appearance;
  const pkg = JSON.stringify({ name: "app", version: "1.0.0", scripts: { build: "tsc" } });
  await page.locator('input[type="file"][accept*="json"]').setInputFiles({ name: "package.json", mimeType: "application/json", buffer: Buffer.from(pkg) });
  await expect(page.getByText("That file is not a hivemind theme.")).toBeVisible();
  await page.waitForTimeout(500);
  expect(onDisk().appearance).toEqual(before);
  await closeSettings();
});

test("increased contrast strengthens faint text and lines with glass off, over the preset's inline palette", async () => {
  expect(hive("config", "set", "appearance.glass.enabled", "false").value).toBe(false);
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(false);
  const read = () => page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    return { fg2: v("--color-fg2"), fg3: v("--color-fg3"), line: v("--color-line"), inline: document.documentElement.style.getPropertyValue("--color-fg3") !== "" };
  });
  const usual = await read();
  expect(usual.inline, "the theme store writes the palette inline, which a plain stylesheet rule cannot beat").toBe(true);
  expect(usual.fg3).not.toBe(usual.fg2);
  await page.emulateMedia({ contrast: "more" });
  try {
    const more = await read();
    expect(more.fg3, "faint text takes the secondary text colour").toBe(more.fg2);
    expect(more.line, "lines are drawn stronger").not.toBe(usual.line);
  } finally {
    await page.emulateMedia({ contrast: null });
  }
});

test("an accent of your own that is hard to see on the panels says so, by the rule a theme's accent is refused by", async () => {
  // Signal: its page #0d0e10, its panels and menus #141517.
  expect(hive("theme", "use", "signal").rescanned).toBe(true);
  await expect.poll(preset, { timeout: 5_000 }).toBe("signal");
  const own = (brand: string) => page.evaluate((b) => window.hive.settingsSet("appearanceExtra.accent", { brand: b, accent: b }), brand);
  await openSettings("appearance");
  const note = page.locator("[data-accent-faint]");
  // 3.07:1 on the page, 2.90:1 on the panels, where a switch that is on and a slider's thumb are drawn.
  await own("#606060");
  await expect(note).toHaveText("Hard to see on the panels (2.9:1).");
  await own("#808080");
  await expect(note).toHaveCount(0);
  await closeSettings();
  expect(hive("theme", "use", "signal").rescanned).toBe(true);
});
