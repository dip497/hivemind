// View plugins + the shared TileHost: switching the workspace between the
// Canvas and Windows views must NOT remount a tile's body. Before the TileHost,
// every body was a child of the active view, so a switch unmounted them all —
// TerminalTile's cleanup then ran ptyDetach, which main routes to killRemotePty
// for an ssh:// tile (remote agents died on ⌘E), local terminals replayed with
// a fresh xterm + WebGL rebuild, editors lost unsaved buffers, browsers reloaded.
//
// The observable contract these specs pin down: the SAME xterm / CodeMirror DOM
// node (tagged with a probe property — a React remount would create a new one)
// is adopted by whichever view is active, exactly one instance exists at any
// time, a minimized tab keeps its surface alive (parked, not unmounted), the
// unsaved editor text survives, and an unknown view id falls back to the canvas.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
let repo: string;
const FILE = "notes.ts";
const MARK = "UNSAVED_VIEW_SWITCH_MARKER";

const toggleView = async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
};
const probe = (sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as unknown as Record<string, unknown> | null)?.__probe ?? null, sel);
// Tag the live canvas xterm. A React unmount+remount would create a brand-new
// element without this property. Each test tags at its start: a retried test
// runs in a fresh worker (new app), so a tag set by an earlier test is gone.
const tagCanvasXterm = () =>
  page.locator(".react-flow__node-terminal .xterm").first().evaluate((el) => {
    (el as unknown as Record<string, unknown>).__probe = "kept";
  });

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-views-"));
  await fs.writeFile(path.join(repo, FILE), "export const n = 1;\n", "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-views-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error") console.log("[r.error]", m.text()); });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 10_000 });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("the terminal body is one instance, adopted by each view in turn — never remounted", async () => {
  await tagCanvasXterm();
  await expect(page.locator(".xterm")).toHaveCount(1);

  // → Windows. The canvas is gone; the SAME xterm now sits inside a tab body.
  await toggleView();
  await page.waitForSelector('[role="tablist"]');
  expect(await page.locator(".react-flow").count()).toBe(0);
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe('[data-tile-id] .xterm')).toBe("kept");
  expect(await page.getAttribute("[data-active-view]", "data-active-view")).toBe("windows");

  // → Canvas. Same element again, back inside the react-flow node.
  await toggleView();
  await page.waitForSelector(".react-flow__node-terminal");
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
  // No session teardown surfaced: a killed PTY prints its exit banner and the
  // header status flips to "exited".
  await page.waitForTimeout(400);
  await expect(page.locator(".hm-term-root").filter({ hasText: "exited" })).toHaveCount(0);
});

test("the camera survives a canvas → windows → canvas round trip (no snap back to launch viewport)", async () => {
  const viewportTransform = () =>
    page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform);
  const before = await viewportTransform();
  // Pan away from the launch viewport by wheeling over the EMPTY pane
  // (panOnScroll) — over the tile the terminal would own the wheel instead, and
  // the bottom-RIGHT corner is where the update/agent toasts land, so aim at
  // the bottom-centre strip below the tile. Wheel delivery is async under
  // xvfb: keep nudging until the transform actually changes.
  const pane = page.locator(".react-flow__pane");
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.97);
  await expect.poll(async () => {
    await page.mouse.wheel(80, 60);
    await page.waitForTimeout(120);
    return viewportTransform();
  }, { timeout: 8_000, intervals: [50] }).not.toBe(before);
  await page.waitForTimeout(800); // pan-end commit + crisp snap settle
  const panned = await viewportTransform();
  expect(panned).not.toBe(before);
  await toggleView();
  await page.waitForSelector('[role="tablist"]');
  await page.waitForTimeout(300);
  await toggleView();
  await page.waitForSelector(".react-flow__viewport");
  // Remount resumes from the live viewport, not react-flow's launch-time default.
  // react-flow applies `defaultViewport` once its container is measured (the
  // transform is identity until then), which can take a beat under load.
  await expect.poll(viewportTransform, { timeout: 8_000, intervals: [100] }).toBe(panned);
});

test("a minimized tab keeps its surface alive (parked, not unmounted) and comes back intact", async () => {
  await tagCanvasXterm();
  await toggleView();
  await page.waitForSelector('[role="tablist"]');
  const tab = page.locator('[role="tab"]').first();
  await tab.hover();
  await tab.getByRole("button", { name: /^Minimize/ }).click();
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  // Still exactly one xterm — now in the hidden park, still the tagged instance.
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe("#hm-tile-park .xterm")).toBe("kept");
  // Restore from the rail → adopted by the tab body again.
  const rail = page.locator('aside[aria-label="Layers"]');
  await rail.locator("button", { hasText: /shell/i }).first().click();
  await expect(page.locator('[role="tab"]')).toHaveCount(1);
  expect(await probe('[data-tile-id] .xterm')).toBe("kept");
  await toggleView();
  await page.waitForSelector(".react-flow__node-terminal");
});

test("an unsaved editor buffer survives a view switch (same CodeMirror instance)", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "tree" })));
  const workbench = page.locator(".react-flow__node-workbench");
  await workbench.waitFor({ timeout: 10_000 });
  const row = workbench.locator("button[role='treeitem']").first();
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.click();
  const content = workbench.locator(".cm-content");
  await expect.poll(async () => content.textContent(), { timeout: 8_000, intervals: [300] }).toContain("const n");
  await content.click();
  await page.keyboard.type(`// ${MARK}\n`);
  await expect(content).toContainText(MARK);
  await content.evaluate((el) => { (el as unknown as Record<string, unknown>).__probe = "cm"; });

  await toggleView();
  await page.waitForSelector('[role="tablist"]');
  // Activate the editor tab (the strip's tab for the workbench tile).
  await page.locator('[role="tab"]', { hasText: /editor|workbench|notes/i }).first().click();
  const tabContent = page.locator('[data-tile-id] .cm-content');
  await expect(tabContent.first()).toContainText(MARK);
  expect(await probe('[data-tile-id] .cm-content')).toBe("cm");
  await expect(page.locator(".cm-content")).toHaveCount(1);

  await toggleView();
  await page.waitForSelector(".react-flow__node-workbench");
  await expect(page.locator(".react-flow__node-workbench .cm-content")).toContainText(MARK);
  expect(await probe(".react-flow__node-workbench .cm-content")).toBe("cm");
});

test("an unknown view id falls back to the canvas instead of blanking the workspace", async () => {
  await tagCanvasXterm();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "mars-base" } })));
  await page.waitForTimeout(200);
  await expect(page.locator(".react-flow")).toHaveCount(1);
  expect(await page.getAttribute("[data-active-view]", "data-active-view")).toBe("canvas");
  await expect(page.locator("[data-view-failure]")).toHaveCount(0);
  // Every body still alive.
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
});
