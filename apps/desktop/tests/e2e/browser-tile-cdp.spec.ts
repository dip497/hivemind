// Verify the Browser tile end-to-end:
//   1. It spawns and mounts a real <webview> guest.
//   2. The main-process CDP bridge (browserCdp) attaches the debugger to the
//      VISIBLE tab and can navigate it + read its DOM — the exact path an agent
//      uses. Uses a data: URL so the assertion is network-independent.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [
      path.join(APP_DIR, "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=/tmp/hivemind-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ],
    cwd: APP_DIR,
  });
  page = await app.firstWindow();
  page.on("console", (m) => console.log(`[r.${m.type()}]`, m.text()));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 10_000 });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await app?.close();
});

test("browser tile: spawns a <webview> and is drivable over CDP", async () => {
  // 1. Spawn a frame (hotkey "6"), then open a Browser tile in it.
  await page.keyboard.press("6");
  await page.waitForSelector(".react-flow__node-frame", { timeout: 3_000 });
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  expect(frameId).toBeTruthy();

  await page.evaluate((fid) => {
    window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } }));
  }, frameId);

  await page.waitForSelector(".react-flow__node-browser", { timeout: 5_000 });
  const tileId = await page.locator(".react-flow__node-browser").first().getAttribute("data-id");
  expect(tileId).toBeTruthy();
  console.log("browser tile id:", tileId);

  // 2. A real <webview> guest mounted.
  await page.waitForSelector("webview", { timeout: 5_000 });
  expect(await page.locator("webview").count()).toBeGreaterThanOrEqual(1);

  // 3. Wait until the guest's dom-ready has registered it with the CDP bridge
  //    (browserCdp throws "no browser tile registered" until then).
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          try {
            await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1+1", returnByValue: true });
            return "ready";
          } catch (e) {
            return String((e as Error).message ?? e);
          }
        }, tileId),
      { timeout: 25_000, intervals: [400] },
    )
    .toBe("ready");

  // 4. Drive the visible tab over CDP: navigate it to a known page...
  await page.evaluate(
    (id) =>
      window.hive.browserCdp(id, "Page.navigate", {
        url: "data:text/html,<title>HiveCDP</title><h1 id=h>cdp-drove-this</h1>",
      }),
    tileId,
  );

  // 5. ...and read its DOM back, proving the bridge controls the live page.
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const r = (await window.hive.browserCdp(id, "Runtime.evaluate", {
            expression: "document.title + '|' + (document.getElementById('h')?.textContent ?? '')",
            returnByValue: true,
          })) as { result?: { value?: string } };
          return r?.result?.value ?? "";
        }, tileId),
      { timeout: 10_000, intervals: [300] },
    )
    .toBe("HiveCDP|cdp-drove-this");

  console.log("✓ CDP navigated the visible tab and read its DOM");
});
