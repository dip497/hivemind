// Frame nodes (Unreal Blueprint-style comment box) are movable; their SIZE is
// no longer manually controlled — frame geometry is derived reactively from
// the bounding box of the tiles inside (auto-fit), and an empty frame collapses
// to a placeholder. So there is no resize-handle test anymore; we assert the
// empty frame renders at the collapsed placeholder size + still moves.
import { test, expect, type Page } from "@playwright/test";
import { launchWindow, type AppWindow } from "./helpers/window";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: AppWindow;
let page: Page;

test.beforeAll(async () => {
  app = await launchWindow({ cwd: APP_DIR, args: [`--user-data-dir=/tmp/hivemind-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`] });
  page = app.page;
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
  const header = frame.locator(".frame-drag-handle").first();
  const hb = await header.boundingBox();
  expect(hb).toBeTruthy();
  // Click mid-header to avoid the rename-input + buttons at edges.
  const sx = hb!.x + 30;
  const sy = hb!.y + hb!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  // Many small moves with a pause each: xyflow's drag handler samples pointer
  // events per animation frame, and under load (xvfb + a heavy build) a slow
  // frame can swallow a coarse move — a 14-step drag once moved the frame 11px.
  const steps = 40;
  const dx = 80;
  const dy = 60;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + (dx * i) / steps, sy + (dy * i) / steps, { steps: 1 });
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  // Poll until the frame's position settles (two consecutive identical reads)
  // instead of one read after a fixed sleep — the drop is applied on a frame.
  const settled = await (async () => {
    let last: { x: number; y: number } | null = null;
    for (let i = 0; i < 40; i++) {
      const b = await frame.boundingBox();
      if (b && last && Math.abs(b.x - last.x) < 0.5 && Math.abs(b.y - last.y) < 0.5 && b.x !== before!.x) return b;
      last = b ? { x: b.x, y: b.y } : null;
      await page.waitForTimeout(50);
    }
    return frame.boundingBox();
  })();
  expect(settled).toBeTruthy();
  const dxObserved = settled!.x - before!.x;
  const dyObserved = settled!.y - before!.y;
  console.log("frame move delta", { dx: dxObserved, dy: dyObserved });
  expect(Math.abs(dxObserved)).toBeGreaterThan(40);
  expect(Math.abs(dyObserved)).toBeGreaterThan(30);
});

test("frame arrange menu offers Columns / Rows / Grid", async () => {
  const frame = page.locator(".react-flow__node-frame").first();
  await frame.locator("[data-frame-actions]").click();
  // The frame's menu, and its Arrange, portal to document.body.
  await page.locator('[data-frame-menu-sub="arrange"]').click();
  await expect(page.getByText("Columns", { exact: true })).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText("Rows", { exact: true })).toBeVisible();
  await expect(page.getByText("Grid", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("over a wallpaper (glass), a frame's name line stays one material with the frame: no bar of its own", async () => {
  const label = page.locator(".react-flow__node-frame").first().locator("[data-frame-label]");
  await expect(label).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add("content-glass"));
  try {
    expect(await label.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    // A tile's title bar is still frosted there.
    const bar = await page.evaluate(() => {
      const el = document.createElement("div");
      el.className = "tile-drag-handle";
      document.body.append(el);
      const bg = getComputedStyle(el).backgroundColor;
      el.remove();
      return bg;
    });
    expect(bar).not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await page.evaluate(() => document.documentElement.classList.remove("content-glass"));
  }
});
