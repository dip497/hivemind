// Frame nodes (Unreal Blueprint-style comment box) are movable; their SIZE is
// no longer manually controlled — frame geometry is derived reactively from
// the bounding box of the tiles inside (auto-fit), and an empty frame collapses
// to a placeholder. So there is no resize-handle test anymore; we assert the
// empty frame renders at the collapsed placeholder size + still moves.
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
  page.on("console", (m) => console.log(`[renderer.${m.type()}]`, m.text()));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 10_000 });

  // Switch to canvas + add a frame via the "f" tool hotkey (Excalidraw style).
  await page.waitForTimeout(300);
  await page.keyboard.press("6"); // frame hotkey (letter aliases removed)
  await page.waitForSelector(".react-flow__node-frame", { timeout: 4_000 });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await app?.close();
});

test("empty frame has NO manual resize handle (auto-fit owns geometry)", async () => {
  const frame = page.locator(".react-flow__node-frame").first();
  await expect(frame).toBeVisible();
  await frame.click({ position: { x: 30, y: 4 } });
  // Frames are no longer manually resizable — the NodeResizer was removed.
  const handle = page.locator(
    ".react-flow__node-frame .react-flow__resize-control.handle"
  );
  await expect(handle).toHaveCount(0);
});

test("frame header-drag moves it", async () => {
  const frame = page.locator(".react-flow__node-frame").first();
  const before = await frame.boundingBox();
  expect(before).toBeTruthy();

  // Drag handle is the colored header bar inside the frame.
  const header = frame.locator(".tile-drag-handle").first();
  const hb = await header.boundingBox();
  expect(hb).toBeTruthy();
  // Click mid-header to avoid the rename-input + buttons at edges.
  const sx = hb!.x + 30;
  const sy = hb!.y + hb!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const steps = 14;
  const dx = 80;
  const dy = 60;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + (dx * i) / steps, sy + (dy * i) / steps, { steps: 1 });
    await page.waitForTimeout(14);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const after = await frame.boundingBox();
  expect(after).toBeTruthy();
  const dxObserved = after!.x - before!.x;
  const dyObserved = after!.y - before!.y;
  console.log("frame move delta", { dx: dxObserved, dy: dyObserved });
  expect(Math.abs(dxObserved)).toBeGreaterThan(40);
  expect(Math.abs(dyObserved)).toBeGreaterThan(30);
});
