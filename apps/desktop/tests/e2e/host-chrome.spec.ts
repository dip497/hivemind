// Host chrome over every view (design doc 6a): the tool island is drawn by the
// workspace runtime, so Windows, World and community views can spawn; docked
// surfaces in World/community get the host's slot bar (name, status, pop-out,
// undock, Shift+Esc); the wallpaper layer and glass are mounted only under
// views that declare `wallpaper: true`.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const ORBIT = path.resolve(APP_DIR, "../../examples/views/orbit");
// Own profile: specs in one run share XDG_CONFIG_HOME (playwright.config.ts),
// and an app launched without --user-data-dir would resume the previous spec's
// userData (view mode, layouts). The HCP socket must live under the profile
// the CLI sees, so the isolation is the env, not --user-data-dir.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-chrome-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;

const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const activeView = () => page.getAttribute("[data-active-view]", "data-active-view");
const terminalNodes = async () => { await toView("canvas"); await page.waitForSelector(".react-flow__node-terminal"); await page.waitForTimeout(200); return page.locator(".react-flow__node-terminal").count(); };

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-chrome-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
  execFileSync("node", [path.join(ORBIT, "build.mjs")], { stdio: "ignore" });
  execFileSync("bun", [CLI, "views", "install", path.join(ORBIT, "dist"), "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error" && !/Content Security Policy/.test(m.text())) console.log("[r.error]", m.text()); });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  // These cases test toolbar ownership and wallpaper mounting, not animation
  // throughput. Keep glass enabled, but isolate them from the known software-
  // rendering cost of animated gradients (measured by perf-canvas-effects).
  await page.evaluate(() => window.hive.settingsSet("appearance.glass.animate", false));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 10_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(XDG, { recursive: true, force: true }).catch(() => {});
});

test("the island is host chrome: top on the canvas, a compact bottom island in windows / world / a community view, and it spawns from each", async () => {
  await expect(page.locator('[data-host-island="top"] [data-tool-island]')).toBeVisible();
  let n = await terminalNodes();
  for (const [view, ready] of [["windows", "[data-windows-view]"], ["world", "[data-world-canvas]"], ["orbit", '[data-community-view="orbit"][data-community-ready="1"]']] as const) {
    await toView(view);
    await page.waitForSelector(ready, { timeout: 15_000 });
    const island = page.locator('[data-host-island="bottom"] [data-tool-island]');
    await expect(island, `${view}: island visible`).toBeVisible();
    await island.getByTitle(/^Terminal/).click();
    await page.waitForTimeout(400);
    expect(await activeView(), `${view}: spawning does not switch views`).toBe(view);
    const after = await terminalNodes();
    expect(after, `${view}: one more terminal`).toBe(n + 1);
    n = after;
  }
});

test("the toolbar's Theme button opens the unified Appearance settings from a non-canvas view", async () => {
  await toView("windows");
  const theme = page.locator('[data-host-island="bottom"] [data-tool-island]').getByTitle(/^Theme/);
  await theme.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator('[data-settings-page="appearance"]')).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(theme).toBeFocused();
});

test("wallpaper policy: the full-window layer is mounted only under the canvas and windows; in a scene the theme still applies but nothing composites until a slot exists", async () => {
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal");
  await expect(page.locator(".hm-wallpaper")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);
  await toView("windows");
  await page.waitForTimeout(300);
  await expect(page.locator(".hm-wallpaper")).toHaveCount(1);
  for (const [view, ready] of [["world", "[data-world-canvas]"], ["orbit", '[data-community-view="orbit"][data-community-ready="1"]']] as const) {
    await toView(view);
    await page.waitForSelector(ready, { timeout: 15_000 });
    // 6b: the user's theme wins everywhere (appearance.pluginSurfaces
    // "theme"), so glass stays on — but nothing full-window is composited; a
    // wallpaper element exists only inside a docked slot (settings-appearance.spec).
    await expect(page.locator(".hm-wallpaper"), `${view}: no full-window wallpaper layer`).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on")), `${view}: the theme still applies`).toBe(true);
  }
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal");
  await expect(page.locator(".hm-wallpaper")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.classList.contains("glass-on"))).toBe(true);
});

test("world dock bar: pop out lands on the canvas with the tile selected; Shift+Esc undocks while the terminal has focus", async () => {
  await toView("canvas");
  const tileId = (await page.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  await toView("world");
  await page.waitForSelector("[data-world-canvas]");
  await page.waitForTimeout(400);
  const dock = async () => {
    const pt = await page.evaluate((id) => (document.querySelector("[data-world-view]") as unknown as { __world: { projectTile: (id: string) => { x: number; y: number } | null } }).__world.projectTile(id), tileId);
    const host = (await page.locator("[data-world-view]").boundingBox())!;
    await page.mouse.click(host.x + pt!.x, host.y + pt!.y);
    await expect(page.locator(`[data-world-dock="${tileId}"] [data-slot-bar="${tileId}"]`)).toBeVisible({ timeout: 5_000 });
  };
  await dock();
  await page.locator(`[data-slot-bar="${tileId}"]`).getByLabel("Pop out to canvas").click();
  await expect.poll(activeView).toBe("canvas");
  await expect(page.locator(`.react-flow__node-terminal[data-id="${tileId}"] .hm-node-selected`)).toHaveCount(1, { timeout: 5_000 });
  await toView("world");
  await page.waitForSelector("[data-world-canvas]");
  await page.waitForTimeout(400);
  await dock();
  await page.locator("[data-world-dock] .xterm-screen").click();
  expect(await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea"))).toBe(true);
  await page.keyboard.press("Escape"); // plain Esc belongs to the terminal
  await expect(page.locator("[data-world-dock]")).toHaveCount(1);
  await page.keyboard.press("Shift+Escape");
  await expect(page.locator("[data-world-dock]")).toHaveCount(0);
});

test("community slot bar: the host's undock releases the tile and tells the plugin; Shift+Esc works there too", async () => {
  await toView("canvas");
  const tileId = (await page.locator(".react-flow__node-terminal").first().getAttribute("data-id"))!;
  await toView("orbit");
  await page.waitForSelector('[data-community-view="orbit"][data-community-ready="1"]', { timeout: 15_000 });
  const dock = async () => {
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    await expect.poll(async () => (rect = await page.evaluate((id) => (document.querySelector("[data-community-view]") as unknown as { __community: { reveal: (id: string) => Promise<{ x: number; y: number; w: number; h: number } | null> } }).__community.reveal(id), tileId)), { timeout: 10_000 }).toBeTruthy();
    const host = (await page.locator("[data-community-view]").boundingBox())!;
    for (let i = 0; i < 3 && (await page.locator(`[data-community-slot="${tileId}"]`).count()) === 0; i++) {
      await page.mouse.click(host.x + rect!.x + rect!.w / 2, host.y + rect!.y + rect!.h / 2);
      await page.waitForTimeout(500);
    }
    await expect(page.locator(`[data-community-slot="${tileId}"] [data-slot-bar="${tileId}"]`)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-community-slot="${tileId}"] .xterm`)).toHaveCount(1);
  };
  await dock();
  await page.locator(`[data-slot-bar="${tileId}"]`).getByLabel("Undock").click();
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  // The plugin heard `undock` (it deselected on its side), the surface is parked.
  await expect(page.locator(`#hm-tile-park [data-surface="${tileId}"] .xterm`)).toHaveCount(1);
  await dock();
  await page.locator(`[data-community-slot="${tileId}"] .xterm-screen`).click();
  await page.keyboard.press("Shift+Escape");
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal .xterm");
});

test("toolbar Off is per-view, persists through restart, and Settings restores it", async () => {
  await toView("canvas");
  const original = await page.locator(".xterm").first().elementHandle();
  const settings = () => page.getByRole("button", { name: "settings", exact: true });
  await settings().click();
  await page.locator('[data-settings-page="views"]').click();
  await page.getByLabel("Display", { exact: true }).selectOption("off");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await expect(settings()).toBeFocused();
  expect(await page.locator(".xterm").first().evaluate((node, old) => node === old, original)).toBe(true);
  await original?.dispose();
  await toView("windows");
  await expect(page.locator('[data-host-island="bottom"]')).toBeVisible();
  await toView("canvas");
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  const config = () => JSON.parse(execFileSync("bun", [CLI, "config", "get", "views.chrome", "--json"], { env: ENV, encoding: "utf8" })).data;
  await expect.poll(config).toMatchObject({ canvas: { island: "off" } });
  await app.close();
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  // Exercise keyboard recovery through the app-owned Settings button.
  await settings().focus();
  await page.keyboard.press("Enter");
  await page.locator('[data-settings-page="views"]').click();
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("off");
  await page.getByLabel("Display", { exact: true }).selectOption("auto");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator('[data-host-island="top"]')).toBeVisible();
});

test("collapsed toolbar expansion does not leak across views or placement changes", async () => {
  const configure = (chrome: Record<string, { island: "hidden" | "off" }>) => page.evaluate((value) => window.hive.settingsSet("views.chrome", value), chrome);
  await configure({ canvas: { island: "hidden" }, windows: { island: "hidden" } });
  await toView("canvas");
  await expect(page.locator("[data-host-island]")).toHaveCount(0);
  await page.getByRole("button", { name: "show tools", exact: true }).click();
  await expect(page.locator("[data-host-island]")).toBeVisible();
  await toView("windows");
  await expect(page.getByRole("button", { name: "show tools", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-host-island]")).toHaveCount(0);
  await page.getByRole("button", { name: "show tools", exact: true }).click();
  await configure({ windows: { island: "off" } });
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await configure({ windows: { island: "hidden" } });
  await expect(page.getByRole("button", { name: "show tools", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-host-island]")).toHaveCount(0);
  await configure({});
});
