// Verify: spawn a frame, drag a terminal tile inside it. Two things to assert:
//   1. The tile ends up inside the frame's bounds (containment / reparenting)
//   2. Moving the frame after also moves the tile (true parent-child link)
//
// React-flow handles parent/child via `parentId` + `extent: 'parent'`. Our
// Canvas auto-parents at SPAWN time only (parentFrameOf checks the spawn
// (x,y)). If a tile is dragged INTO a frame after spawn, react-flow does NOT
// auto-reparent — that's the gap the user suspects.
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

test("drag terminal into frame: ends up visually inside but NOT reparented", async () => {
  // 1. Spawn a frame (via "f" hotkey) + a terminal tile.
  await page.keyboard.press("6"); // frame hotkey (letter aliases removed)
  await page.waitForSelector(".react-flow__node-frame", { timeout: 3_000 });

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" }));
  });
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 4_000 });
  await page.waitForTimeout(500);

  const frame = page.locator(".react-flow__node-frame").first();
  const term = page.locator(".react-flow__node-terminal").first();

  const frameBox = await frame.boundingBox();
  const termBox = await term.boundingBox();
  console.log("initial", { frame: frameBox, term: termBox });
  expect(frameBox && termBox).toBeTruthy();

  // 2. Drag the terminal tile by its drag handle into the middle of the frame.
  const dragHandle = term.locator(".tile-drag-handle").first();
  const dhBox = await dragHandle.boundingBox();
  expect(dhBox).toBeTruthy();
  const sx = dhBox!.x + dhBox!.width / 2;
  const sy = dhBox!.y + dhBox!.height / 2;
  const tx = frameBox!.x + frameBox!.width / 2;
  const ty = frameBox!.y + frameBox!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sx + ((tx - sx) * i) / steps, sy + ((ty - sy) * i) / steps, { steps: 1 });
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const termAfter = await term.boundingBox();
  console.log("after drag", { term: termAfter, frame: frameBox });

  // (a) Terminal visually overlaps the frame.
  const ov = !!(
    termAfter &&
    termAfter.x + termAfter.width > frameBox!.x &&
    termAfter.x < frameBox!.x + frameBox!.width &&
    termAfter.y + termAfter.height > frameBox!.y &&
    termAfter.y < frameBox!.y + frameBox!.height
  );
  expect(ov).toBe(true);

  // (b) Check if react-flow actually reparented (the gap we want to detect).
  const parentInfo = await page.evaluate(() => {
    const n = document.querySelector(".react-flow__node-terminal");
    return {
      dataParent: n?.getAttribute("data-parent-id") || null,
      // The CSS transform contains the absolute or relative origin —
      // reparented tiles render via frame's transform.
      transform: (n as HTMLElement)?.style.transform || null,
    };
  });
  console.log("parent attr after drag:", parentInfo);

  // 3. Move the frame — if the tile is parented it follows, if not it stays put.
  const frameHeader = frame.locator(".tile-drag-handle").first();
  const fhBox = await frameHeader.boundingBox();
  expect(fhBox).toBeTruthy();
  const fsx = fhBox!.x + 30;
  const fsy = fhBox!.y + fhBox!.height / 2;
  await page.mouse.move(fsx, fsy);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) {
    await page.mouse.move(fsx + (180 * i) / 16, fsy + (120 * i) / 16, { steps: 1 });
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const termAfterFrameMove = await term.boundingBox();
  const frameAfterMove = await frame.boundingBox();
  console.log("frame moved", { frame: frameAfterMove, term: termAfterFrameMove });

  const tileFollowed =
    termAfterFrameMove &&
    termAfter &&
    Math.abs(termAfterFrameMove.x - termAfter.x) > 100 &&
    Math.abs(termAfterFrameMove.y - termAfter.y) > 80;
  console.log(
    tileFollowed ? "✓ tile followed frame (reparented)" : "✗ TILE DID NOT FOLLOW (gap: drag-in does not reparent)"
  );

  // Don't fail the test — this is diagnostic. Print the gap.
  if (!tileFollowed) {
    console.log("REPRO: drag-in-frame does NOT auto-reparent. To fix, intercept onNodeDragStop and assign parentId when tile center lies inside a frame.");
  }
});

