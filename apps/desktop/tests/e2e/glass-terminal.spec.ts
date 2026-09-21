// A glass terminal shows the wallpaper through a program that fills the whole
// screen with its own background colour, and still paints the panels drawn on it.
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
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-glass-xdg-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;

test.beforeAll(async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-glass-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const key of ["appearance.glass.enabled", "appearance.glass.contentGlass"]) {
    execFileSync("bun", [CLI, "config", "set", key, "true", "--json"], { cwd: repo, env: ENV, stdio: "ignore" });
  }
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  // The fix lives in the WebGL renderer; a fresh, selected tile must be on it.
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

test("a full-screen fill is glass; a panel on it stays opaque", async () => {
  await expect(page.locator("[data-term-bg]").first()).toHaveAttribute("data-term-bg", "rgba(0,0,0,0)");
  const box = (await page.locator(".react-flow__node-terminal .xterm-screen").first().boundingBox())!;
  const corner = { x: box.x + box.width * 0.6, y: box.y + 3 };
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await pixel(corner.x, corner.y);

  // Blue page over the whole screen, red panel on every row but the first and last.
  await page.locator(".react-flow__node-terminal .xterm").first().click();
  await page.keyboard.type(
    "printf '\\e[48;2;0;90;200m\\e[2J\\e[2;1H\\e[48;2;200;0;0m\\e[J\\e['$(tput lines)';1H\\e[48;2;0;90;200m\\e[J'; sleep 60",
  );
  await page.keyboard.press("Enter");

  await expect.poll(() => pixel(centre.x, centre.y).then((c) => near(c, [200, 0, 0])), { timeout: 10_000 }).toBe(true);
  const after = await pixel(corner.x, corner.y);
  expect(near(after, [0, 90, 200]), `page colour painted opaque: ${after}`).toBe(false);
  expect(near(after, before), `corner ${after} should still show what was behind it (${before})`).toBe(true);
});
