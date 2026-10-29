// Frost tool content switched on while a terminal is open: the terminal shows what is behind it,
// not black, and switched off again it is solid again. Its WebGL renderer draws its glyphs for an
// opaque or a clear background when it is made, so the switch has to make it again.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-glass-live-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;

test.beforeAll(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-glass-live-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  // Glass on, tool content solid: the terminal is made for an opaque background.
  execFileSync("bun", [CLI, "config", "set", "appearance.glass.enabled", "true", "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  execFileSync("bun", [CLI, "config", "set", "appearance.glass.contentGlass", "false", "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm-screen canvas", { timeout: 15_000 });
});

test.afterAll(async () => { await app?.close(); });

/** RGB of the window at a CSS-pixel point. */
const pixel = (x: number, y: number) => app.evaluate(async ({ BrowserWindow }, p) => {
  const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
  const scale = img.getSize().width / BrowserWindow.getAllWindows()[0]!.getContentBounds().width;
  const i = (Math.round(p.y * scale) * img.getSize().width + Math.round(p.x * scale)) * 4;
  const b = img.toBitmap();
  return [b[i + 2]!, b[i + 1]!, b[i]!];
}, { x, y });

const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) <= 12);
const setContentGlass = (on: boolean) => page.evaluate((v) => window.hive.settingsSet("appearance.glass.contentGlass", v), on);

test("frosting tool content with a terminal open shows what is behind it, not black, and back", async () => {
  const screen = page.locator(".react-flow__node-terminal .xterm-screen").first();
  const box = (await screen.boundingBox())!;
  // Empty terminal, well below the prompt.
  const at = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.7 };
  const solid = await pixel(at.x, at.y);

  await setContentGlass(true);
  await expect(page.locator("[data-term-bg]").first()).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  await expect.poll(async () => {
    const c = await pixel(at.x, at.y);
    return !near(c, [0, 0, 0]) && !near(c, solid);
  }, { timeout: 10_000, message: "the terminal is painted black or still solid" }).toBe(true);

  await setContentGlass(false);
  await expect.poll(() => pixel(at.x, at.y).then((c) => near(c, solid)), { timeout: 10_000, message: "solid again" }).toBe(true);
});
