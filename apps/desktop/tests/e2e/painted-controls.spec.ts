import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-painted-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
const appDir = process.cwd();
const example = path.resolve(appDir, "../../examples/views/painted-controls");
const toView = (mode: string) => page.evaluate((mode) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), mode);
const scene = () => page.frameLocator('[data-community-view="painted-controls"] iframe');
const dockedTerminals = () => page.locator("[data-community-slot] .xterm");

/**
 * Drive a scene control until the HOST places the slot, retrying the SAME
 * modality (so the mouse case still proves the mouse and the keyboard case
 * still proves the keyboard).
 *
 * Why: the plugin runs in a sandboxed, out-of-process iframe. Under load its
 * first hit-test or key delivery can land before the page's listener is live,
 * and the event is simply dropped — the host never hears `surfaceRects` and the
 * slot never appears. The plugin's "open" is idempotent, so a repeat is safe.
 */
async function dockFromScene(control: Locator, act: (c: Locator) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await dockedTerminals().count() > 0) break;
    await act(control).catch(() => { /* the frame can be mid-navigation */ });
    await page.waitForTimeout(400);
  }
  await expect(dockedTerminals()).toHaveCount(1, { timeout: 10_000 });
}

test.beforeAll(async () => {
  execFileSync("node", [path.join(example, "build.mjs")]);
  execFileSync("bun", [path.resolve(appDir, "../cli/src/index.ts"), "views", "install", path.join(example, "dist"), "--json"], { env });
  app = await electron.launch({ args: [path.join(appDir, "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".xterm");
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("painted controls dock a preserved terminal with mouse and keyboard inside the sandbox", async () => {
  const original = await page.locator(".xterm").elementHandle();
  await page.evaluate(() => window.hive.settingsSet("views.chrome", { "painted-controls": { island: "off" } }));
  await toView("painted-controls");
  await page.waitForSelector('[data-community-ready="1"]');
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "settings", exact: true })).toBeVisible();
  const open = scene().getByRole("button", { name: "Open first tool", exact: true });
  await expect(open).toBeEnabled();
  await dockFromScene(open, (c) => c.click());
  expect(await page.locator(".xterm").evaluate((element, old) => element === old, original)).toBe(true);
  await scene().getByRole("button", { name: "Undock tool", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  expect(await scene().locator("body").evaluate(() => typeof (window as unknown as { hive?: unknown }).hive)).toBe("undefined");
  await dockFromScene(open, async (c) => { await c.focus(); await page.keyboard.press("Space"); });
  await page.screenshot({ path: "/tmp/hivemind-painted-controls.png" });
  await toView("canvas");
  await expect(page.locator(".react-flow__node-terminal .xterm")).toHaveCount(1);
  expect(await page.locator(".xterm").evaluate((element, old) => element === old, original)).toBe(true);
  await original?.dispose();
});

test("painted workspace navigation changes host selection", async () => {
  await toView("canvas");
  const before = await page.locator(".react-flow__node-frame").count();
  await page.getByTitle(/^Frame  /).click();
  await page.getByTitle(/^Frame  /).click();
  await expect(page.locator(".react-flow__node-frame")).toHaveCount(before + 2);
  await toView("painted-controls");
  const next = scene().getByRole("button", { name: "Next workspace", exact: true });
  await expect(next).toBeEnabled();
  const previous = await scene().locator("#status").textContent();
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(scene().locator("#status")).not.toHaveText(previous!);
  // The label changes only on the host selection event, not on button click.
  await scene().getByRole("button", { name: "Previous workspace", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(scene().locator("#status")).toHaveText(previous!);
});

test("the custom controls stop drawing when idle", async () => {
  await toView("painted-controls");
  await page.waitForSelector('[data-community-ready="1"]');
  const draws = () => page.locator('[data-community-view="painted-controls"]').evaluate((element) =>
    (element as unknown as { __community: { stats: { framesDrawn: number } } }).__community.stats.framesDrawn);
  await expect.poll(draws).toBeGreaterThan(0);
  // Frame reports are throttled by the SDK; let the final report arrive before
  // sampling a quiet interval. This checks render activity, not machine FPS.
  await page.waitForTimeout(1100);
  const before = await draws();
  await page.waitForTimeout(1100);
  expect(await draws()).toBe(before);
});
