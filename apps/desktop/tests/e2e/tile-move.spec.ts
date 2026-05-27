// Diagnose: can a terminal tile be dragged at all? Where does drag fire from?
// Suspects:
//   - NodeResizer line controls (z=19, pointer-events:all) covering the header
//   - xterm-helper-textarea over the drag handle
//   - dragHandle selector mismatch
//   - parentFrameOf bug forcing parent at every render → drag gets lost
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
  await page.waitForSelector(".react-flow");
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })),
  );
  await page.waitForSelector(".react-flow__node-terminal");
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
});

test("probe: what element is at the drag handle position?", async () => {
  const info = await page.evaluate(() => {
    const term = document.querySelector(".react-flow__node-terminal")!;
    const handle = term.querySelector(".tile-drag-handle")!;
    const hr = handle.getBoundingClientRect();
    const cx = hr.x + 20;
    const cy = hr.y + hr.height / 2;
    const hit = document.elementFromPoint(cx, cy)!;
    // climb to first ancestor with a class we care about
    const trail: string[] = [];
    let el: Element | null = hit;
    while (el && trail.length < 6) {
      trail.push(`${el.tagName}.${el.className?.toString().slice(0, 80) || ""}`);
      el = el.parentElement;
    }
    return {
      handleRect: { x: hr.x, y: hr.y, w: hr.width, h: hr.height },
      hitClass: hit.className?.toString().slice(0, 100) || "(none)",
      tag: hit.tagName,
      pe: getComputedStyle(hit).pointerEvents,
      z: getComputedStyle(hit).zIndex,
      hasDragHandleClass:
        hit.classList?.contains("tile-drag-handle") || hit.closest(".tile-drag-handle") !== null,
      ancestorTrail: trail,
    };
  });
  console.log("HIT:", JSON.stringify(info, null, 2));
});

test("drag terminal by its header", async () => {
  const term = page.locator(".react-flow__node-terminal").first();
  const before = await term.boundingBox();
  expect(before).toBeTruthy();

  const handle = term.locator(".tile-drag-handle").first();
  const hb = await handle.boundingBox();
  expect(hb).toBeTruthy();
  // Click mid-handle, not the edges (NodeResizer line controls live there)
  const sx = hb!.x + Math.min(40, hb!.width - 10);
  const sy = hb!.y + hb!.height / 2;

  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) {
    await page.mouse.move(sx + (140 * i) / 18, sy + (90 * i) / 18, { steps: 1 });
    await page.waitForTimeout(14);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await term.boundingBox();
  expect(after).toBeTruthy();
  const dx = after!.x - before!.x;
  const dy = after!.y - before!.y;
  console.log("tile move delta", { dx, dy, before, after });
  expect(Math.abs(dx)).toBeGreaterThan(40);
  expect(Math.abs(dy)).toBeGreaterThan(30);
});
