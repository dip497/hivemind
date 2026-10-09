// The Windows view's panes, as an editor's: a tab split right or down into a pane of its own, two
// terminals side by side, the divider dragged and made equal again, one pane maximized, a pane
// closed into its neighbour, and the arrangement as it was left when the view comes back.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-splits-"));
const repo = path.join(root, "repo");
let app: ElectronApplication;
let page: Page;
const view = () => page.frameLocator('[data-community-view="windows"] iframe');
const panesOf = () => view().locator(".w-pane");
const slots = () => page.locator("[data-community-slot]");
const toView = async (mode: string) => {
  await page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
  if (mode === "windows") await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');
  else await page.waitForSelector(".react-flow");
};
/** Each shown slot's box, left to right then top to bottom. */
const boxes = () => slots().evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-community-slot"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })
  .sort((a, b) => a.x - b.x || a.y - b.y));

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(3);
  await toView("windows");
  await expect(view().locator('[role="tab"]')).toHaveCount(3);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("a tab split right takes a pane of its own: two terminals side by side, each the tab its pane shows", async () => {
  await expect(slots()).toHaveCount(1);
  const moved = await view().locator('[role="tab"][aria-selected="true"]').getAttribute("data-tile-id");
  await view().locator(".w-bar").hover();
  await view().locator('[data-pane-tool="Split right"]').click();
  await expect(panesOf()).toHaveCount(2);
  await expect(slots()).toHaveCount(2);
  const [left, right] = await boxes();
  expect(right!.x).toBeGreaterThan(left!.x + left!.w);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
  expect(right!.id).toBe(moved);
  // The moved tab is in the new pane only.
  await expect(panesOf().nth(1).locator('[role="tab"]')).toHaveCount(1);
  await expect(panesOf().nth(0).locator('[role="tab"]')).toHaveCount(2);
});

test("the divider gives one pane more room as it is dragged, and a double-click makes them equal", async () => {
  const [left] = await boxes();
  const grip = view().locator('.w-divider[data-dir="row"]');
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  // Under the pointer, the grip has the terminals let the pointer through, so a drag across them reaches it.
  await expect(slots().first()).toHaveClass(/pointer-events-none/);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + g.width / 2 - i * 20, g.y + g.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await boxes())[0]!.w).toBeLessThan(left!.w - 150);
  await grip.dblclick();
  await expect.poll(async () => { const [a, b] = await boxes(); return Math.abs(a!.w - b!.w); }).toBeLessThan(3);
});

test("split down from the pane's tools puts a third pane under the second", async () => {
  await panesOf().nth(0).locator(".w-bar").hover();
  await panesOf().nth(0).locator('[data-pane-tool="Split down"]').click();
  await expect(panesOf()).toHaveCount(3);
  await expect(slots()).toHaveCount(3);
  const [a, b, c] = await boxes();
  expect(a!.x).toBe(b!.x); // the first pane split into two, one above the other
  expect(b!.y).toBeGreaterThan(a!.y + a!.h);
  expect(c!.x).toBeGreaterThan(a!.x + a!.w);
  await page.screenshot({ path: "/tmp/hivemind-windows-splits.png" });
});

test("a maximized pane is shown alone, and restored among the others", async () => {
  const focused = panesOf().and(view().locator("[data-focused]"));
  await focused.locator('[data-pane-tool="Maximize"]').click();
  await expect(slots()).toHaveCount(1);
  await expect(panesOf()).toHaveCount(1);
  await view().locator('[data-pane-tool="Restore"]').click();
  await expect(slots()).toHaveCount(3);
});

test("the panes are as they were left when the view comes back", async () => {
  const before = await boxes();
  await toView("canvas");
  await toView("windows");
  await expect(slots()).toHaveCount(3);
  expect((await boxes()).map((b) => b.id)).toEqual(before.map((b) => b.id));
});

test("a closed pane gives its tabs to the one that takes its room; every tile is still a tab", async () => {
  const pane = panesOf().nth(2);
  await pane.locator(".w-bar").hover();
  await pane.locator('[data-pane-tool="Close pane"]').click();
  await expect(panesOf()).toHaveCount(2);
  await expect(view().locator('[role="tab"]')).toHaveCount(3);
});
