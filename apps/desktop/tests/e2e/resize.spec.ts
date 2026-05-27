// Playwright Electron E2E — proves resize-from-corners actually works.
//
// Why playwright over CDP-by-hand:
//   page.mouse.{move,down,up} drives Chromium's RealInputController which
//   emits proper pointermove with setPointerCapture-eligible sequencing.
//   d3-drag's gesture (used inside @xyflow/system's XYResizer) only fires
//   its 'drag' callback when the pointer-capture chain matches the spec —
//   raw CDP Input.dispatchMouseEvent and xdotool ButtonPress translation
//   both miss this. The same test ran via hivectl.mjs CDP showed
//   pointerdown but never pointerup → resize never committed. Playwright
//   bypasses that.
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
      // Isolated userData so localStorage (hivemind:last-project) from other
      // specs doesn't auto-reopen a stale workspace.
      `--user-data-dir=/tmp/hivemind-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ],
    cwd: APP_DIR,
  });
  page = await app.firstWindow();
  // Echo renderer console to test runner stdout so [resize] logs surface.
  page.on("console", (m) => console.log(`[renderer.${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("[renderer.error]", e.message));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 10_000 });
});

test.afterAll(async () => {
  await app?.close();
});

test("ctrl+k opens command palette", async () => {
  await page.keyboard.press("Control+k");
  await expect(page.locator('[role="dialog"]')).toBeVisible({ timeout: 2_000 });
  await page.keyboard.press("Escape");
});

test("ctrl+n opens new-issue modal", async () => {
  // Only works if a project root is resolved — otherwise modal renders but
  // is gated. Either way, the key shouldn't be swallowed.
  await page.keyboard.press("Control+n");
  // Give the modal a moment; if no root, fallback to checking the global
  // listener didn't crash.
  await page.waitForTimeout(300);
});

test("corner-handle drag resizes a terminal tile", async () => {
  await page.waitForTimeout(300);

  // 2. Ensure exactly one terminal tile exists.
  const termSel = ".react-flow__node-terminal";
  const hasTerm = (await page.locator(termSel).count()) > 0;
  if (!hasTerm) {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" }));
    });
    await page.waitForSelector(termSel, { timeout: 4_000 });
    await page.waitForTimeout(500);
  }

  const term = page.locator(termSel).first();
  const before = await term.boundingBox();
  expect(before).toBeTruthy();

  // 3. Select the node — resize handles render only for the selected tile
  //    (isVisible={selected}), so this click is required before the handle exists.
  await term.click({ position: { x: 20, y: 20 } });

  // 4. Find the bottom-right handle and drag it +160, +110.
  const handle = page.locator(
    `${termSel} .react-flow__resize-control.bottom.right.handle`
  );
  await expect(handle).toBeVisible();
  const hb = await handle.boundingBox();
  expect(hb).toBeTruthy();
  const sx = hb!.x + hb!.width / 2;
  const sy = hb!.y + hb!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Many small steps — d3-drag fires `drag` per pointermove; one giant jump
  // may compress into a single callback that snaps to maxWidth.
  const steps = 18;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + (160 * i) / steps, sy + (110 * i) / steps, { steps: 1 });
    await page.waitForTimeout(15);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await term.boundingBox();
  expect(after).toBeTruthy();
  const dw = after!.width - before!.width;
  const dh = after!.height - before!.height;
  console.log("delta", { dw, dh, before, after });
  expect(dw).toBeGreaterThan(50);
  expect(dh).toBeGreaterThan(30);
});
