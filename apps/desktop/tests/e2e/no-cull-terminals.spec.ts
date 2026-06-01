// Regression: spawning a new tile must NOT disturb existing terminal tiles.
// react-flow's onlyRenderVisibleElements culls off-viewport nodes by UNMOUNTING
// them — and our tiles wrap live PTY sessions, so a cull tore down (and in the
// non-persistent path, KILLED + respawned = a new claude session) any existing
// terminal pushed off-screen when a spawn recenters the viewport. Culling is
// now disabled; every terminal node must stay mounted regardless of viewport.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-cull-"));
  execSync("git init -q -b main", { cwd: repo });
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-cull-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => { await app?.close(); });

test("all terminal tiles stay mounted past the old cull threshold (>8 nodes)", async () => {
  const N = 12; // comfortably past the old `nodes.length > 8` cull threshold
  for (let i = 0; i < N; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await page.waitForTimeout(250); // let the PTY spawn + node mount settle
  }
  // Each spawn recenters the viewport onto the newest tile, so the earlier ones
  // are now off-screen — exactly the condition that used to cull them.
  const count = await page.locator(".react-flow__node-terminal").count();
  expect(count, "every spawned terminal must remain mounted (no culling)").toBe(N);

  // Pan hard and re-check — off-viewport terminals must still be in the DOM.
  await page.mouse.move(600, 400);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 8; i++) await page.mouse.move(600 - i * 90, 400 - i * 50);
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(300);
  const after = await page.locator(".react-flow__node-terminal").count();
  expect(after, "panning must not unmount any terminal").toBe(N);
});
