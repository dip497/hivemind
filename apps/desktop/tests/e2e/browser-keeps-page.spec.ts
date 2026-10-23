// A browser tile's page lives in a <webview> guest, and a guest whose DOM node
// leaves the document is destroyed. Showing the tile somewhere else (another tab
// in the Windows view, another view) must move it without that: the page keeps
// running, a playing video does not restart and a half-filled form keeps its text.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-keeps-"));
const tabs = () => page.frameLocator('iframe[name="hm-view:windows"]').locator('[role="tab"]');
const windowsReady = () => page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');

const toView = (mode: string) =>
  page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);

// What the guest page answers: its marker, "reloaded" for a fresh page, or
// "not ready" while no page is attached.
const guest = (script: string) =>
  page.evaluate(async (s) => {
    const wv = document.querySelector("webview") as (HTMLElement & { executeJavaScript(c: string): Promise<unknown> }) | null;
    try { return (await wv?.executeJavaScript(s)) ?? "not ready"; } catch { return "not ready"; }
  }, script);
const marker = () => guest("window.__marker ?? 'reloaded'");
const markPage = () =>
  expect.poll(() => guest("window.__marker = 'kept'"), { timeout: 15_000, intervals: [200] }).toBe("kept");

async function expectSamePage() {
  await expect.poll(marker, { timeout: 10_000, intervals: [100] }).not.toBe("not ready");
  expect(await marker()).toBe("kept");
}

test.beforeAll(async () => {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`],
    cwd: process.cwd(), env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 10_000 });
  await page.keyboard.press("6");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id", { timeout: 5_000 });
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  await page.waitForSelector(".react-flow__node-browser webview", { timeout: 10_000 });
});

test.afterAll(async () => {
  await page?.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } }));
    await window.hive.settingsSet("views.defaultView", "canvas");
  }).catch(() => {});
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("the page survives switching to another tab and back", async () => {
  await markPage();
  await toView("windows");
  await windowsReady();
  await tabs().filter({ hasText: /browser/i }).first().click();
  await expectSamePage();
  await tabs().filter({ hasText: /shell/i }).first().click();
  await tabs().filter({ hasText: /browser/i }).first().click();
  await expectSamePage();
});

test("the page survives a canvas → windows → canvas round trip", async () => {
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-browser webview");
  await markPage();
  await toView("windows");
  await windowsReady();
  await tabs().filter({ hasText: /browser/i }).first().click();
  await expectSamePage();
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-browser webview");
  await expectSamePage();
  await expect(page.locator("webview")).toHaveCount(1);
});
