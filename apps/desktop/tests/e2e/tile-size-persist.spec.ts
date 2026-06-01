// Repro: does a resized tile keep its size across an app restart?
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let repo: string;
let userData: string;

test.beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "hm-size-"));
  execSync("git init -q -b main", { cwd: repo });
  userData = mkdtempSync(path.join(tmpdir(), "hm-size-ud-"));
});

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${userData}`],
    cwd: repo,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(500);
  return { app, page };
}

const boxOf = async (page: Page) => {
  const b = await page.locator(".react-flow__node-terminal").first().boundingBox();
  return b!;
};

test("a resized tile keeps its size after restart", async () => {
  // ── session 1: spawn a shell, resize it bigger ──
  let { app, page } = await launch();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 8000 });
  await page.waitForTimeout(600);
  const before = await boxOf(page);

  // select the tile (resize handles render only when selected: isVisible={selected})
  const term = page.locator(".react-flow__node-terminal").first();
  await term.click({ position: { x: 20, y: 20 } });
  const handle = page.locator(".react-flow__node-terminal .react-flow__resize-control.bottom.right.handle").first();
  await expect(handle).toBeVisible();
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no resize handle — is NodeResizer visible on select?");
  const sx = hb.x + hb.width / 2, sy = hb.y + hb.height / 2;
  // many small steps — d3-drag fires per pointermove (one giant jump can snap)
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 18; i++) { await page.mouse.move(sx + (200 * i) / 18, sy + (150 * i) / 18, { steps: 1 }); await page.waitForTimeout(15); }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const resized = await boxOf(page);
  expect(resized.width, "resize should enlarge the tile").toBeGreaterThan(before.width + 80);

  // give the 250ms debounced layout-persist time, then close (beforeunload flush)
  await page.waitForTimeout(500);
  await app.close();

  // ── session 2: relaunch same userData+cwd, expect the size to come back ──
  ({ app, page } = await launch());
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 8000 });
  await page.waitForTimeout(800);
  const restored = await boxOf(page);
  expect(Math.abs(restored.width - resized.width), "width must persist across restart").toBeLessThan(12);
  expect(Math.abs(restored.height - resized.height), "height must persist across restart").toBeLessThan(12);
  await app.close();
});
