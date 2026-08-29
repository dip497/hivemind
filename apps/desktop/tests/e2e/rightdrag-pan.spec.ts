// PROBE: right-mouse drag must pan the canvas. Temporary diagnostic.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-rd-"));
  execSync("git init -q -b main", { cwd: repo });
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-rd-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => { await app?.close(); });

const transform = () => page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

async function drag(button: "left" | "middle" | "right", from: [number, number], to: [number, number], holdKey?: string) {
  if (holdKey) await page.keyboard.down(holdKey);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button });
  for (let i = 1; i <= 10; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
  await page.mouse.up({ button });
  if (holdKey) await page.keyboard.up(holdKey);
  await page.waitForTimeout(200);
}

test("right-mouse drag on empty canvas pans", async () => {
  const before = await transform();
  await drag("right", [400, 400], [600, 520]);
  const after = await transform();
  console.log("RIGHT-DRAG  before:", before, " after:", after);
  expect(after, "right-drag should change the viewport").not.toBe(before);
});

test("middle-mouse drag pans", async () => {
  const before = await transform();
  await drag("middle", [400, 400], [560, 500]);
  const after = await transform();
  expect(after).not.toBe(before);
});

test("right-drag STARTING ON AN UNSELECTED TILE pans (the realistic case)", async () => {
  // spawn a terminal so the canvas has a tile under the cursor.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 8_000 });
  await page.waitForTimeout(800);
  // Deselect by clicking EMPTY pane, not (8,8) — the top-left corner is the
  // Layers panel, and a click there never reaches onPaneClick (the spawn
  // auto-selects the tile; right-drag pan is unselected-only over a tile).
  // Escape → fit-all zoom-out leaves empty canvas in the corners.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await page.mouse.click(60, 60);
  await page.waitForTimeout(300);
  const box = await page.locator(".react-flow__node-terminal").first().boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const before = await transform();
  await drag("right", [cx, cy], [cx + 180, cy + 120]);
  const after = await transform();
  console.log("RIGHT-DRAG-OVER-TILE before:", before, " after:", after);
  expect(after, "right-drag over a tile should pan").not.toBe(before);
});

test("Space+left-drag STARTING ON A (selected) TILE pans — the tile-covered-canvas escape hatch", async () => {
  // The tile may still be selected from the previous test's interactions —
  // irrelevant here: Space+drag must pan from ANY node because space-pan makes
  // node elements pointer-transparent (the nopan trap fix).
  const box = await page.locator(".react-flow__node-terminal").first().boundingBox();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const before = await transform();
  await drag("left", [cx, cy], [cx - 200, cy - 140], "Space");
  const after = await transform();
  console.log("SPACE-DRAG-OVER-TILE before:", before, " after:", after);
  expect(after, "Space+drag over a tile should pan").not.toBe(before);
  // The pan lock must clear on keyup — a stuck space-pan would make every tile
  // unclickable (pointer-events:none lingers).
  const stuck = await page.evaluate(() => document.body.classList.contains("space-pan"));
  expect(stuck, "space-pan class cleared on keyup").toBe(false);
});
