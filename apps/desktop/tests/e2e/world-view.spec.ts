// The World view (design doc phase 3): registered as the third view, lazy
// (three.js is not in the default chunk), and — the contract proof — a tile's
// live surface docks in a DOM panel over the scene on click, undocks on Esc,
// and the same xterm instance survives canvas → world → canvas. A crash in the
// world view falls back to the canvas with sessions intact.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";

// Tracing off for THIS spec: the trace's per-action screenshots read back a
// full-window WebGL canvas, which under xvfb's software GL costs ~10 s per step
// (the same tests run in 2–3 s without it) — harness overhead that pushed the
// first mount past its timeout, not a cost the app has.
test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;

const toView = async (mode: string) => {
  await page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
};
const toggleView = async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
};
const activeView = () => page.getAttribute("[data-active-view]", "data-active-view");
const probe = (sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as unknown as Record<string, unknown> | null)?.__probe ?? null, sel);
// The World chunk sets a marker when evaluated (see WorldView.tsx); the build
// guard (renderer-chunks.test.ts) proves three.js lives only in that lazy path.
const loadedThreeChunk = () => page.evaluate(() => (window as Window & { __hivemindWorldLoaded?: true }).__hivemindWorldLoaded === true);

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-world-"));
  await fs.writeFile(path.join(repo, "a.ts"), "export const a = 1;\n", "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-world-ud-${Date.now()}`],
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

test("three.js is lazy: not loaded on the canvas, loaded on the first switch to the World view", async () => {
  expect(await loadedThreeChunk()).toBe(false);
  await toView("world");
  await page.waitForSelector("[data-world-canvas]", { timeout: 15_000 });
  expect(await activeView()).toBe("world");
  expect(await loadedThreeChunk()).toBe(true);
  await toView("canvas");
  await page.waitForSelector(".react-flow");
});

test("the World view is in the ⌘E cycle: canvas → windows → world → canvas", async () => {
  expect(await activeView()).toBe("canvas");
  await toggleView();
  await page.waitForSelector('[role="tablist"]');
  expect(await activeView()).toBe("windows");
  await toggleView();
  await page.waitForSelector("[data-world-canvas]");
  expect(await activeView()).toBe("world");
  await toggleView();
  await page.waitForSelector(".react-flow");
  expect(await activeView()).toBe("canvas");
});

test("canvas → world → canvas keeps the same xterm instance (parked while undocked, never remounted)", async () => {
  await page.locator(".react-flow__node-terminal .xterm").first().evaluate((el) => { (el as unknown as Record<string, unknown>).__probe = "kept"; });
  await toView("world");
  await page.waitForSelector("[data-world-canvas]");
  // Undocked: the surface is parked (alive, hidden), exactly one instance.
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe("#hm-tile-park .xterm")).toBe("kept");
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal .xterm");
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
  await expect(page.locator(".hm-term-root").filter({ hasText: "exited" })).toHaveCount(0);
});

test("click a building: its live terminal docks in a DOM panel, typed keys arrive, Esc undocks; rendering is on demand", async () => {
  const tileId = await page.locator(".react-flow__node-terminal").first().getAttribute("data-id");
  expect(tileId).toBeTruthy();
  await toView("world");
  await page.waitForSelector("[data-world-canvas]");
  await page.waitForTimeout(400);
  // Render-on-demand: no frames are drawn while nothing changes.
  const framesBefore = await page.evaluate(() => (document.querySelector("[data-world-view]") as unknown as { __world: { frameCount: number } }).__world.frameCount);
  await page.waitForTimeout(1000);
  const framesAfterIdle = await page.evaluate(() => (document.querySelector("[data-world-view]") as unknown as { __world: { frameCount: number } }).__world.frameCount);
  expect(framesAfterIdle).toBe(framesBefore);
  // Hover shows the tile name; click docks it.
  const pt = await page.evaluate((id) => (document.querySelector("[data-world-view]") as unknown as { __world: { projectTile: (id: string) => { x: number; y: number } | null } }).__world.projectTile(id), tileId!);
  expect(pt).toBeTruthy();
  const host = (await page.locator("[data-world-view]").boundingBox())!;
  await page.mouse.move(host.x + pt!.x, host.y + pt!.y);
  await expect(page.locator("[data-world-hover]")).toBeVisible({ timeout: 3_000 });
  await page.mouse.click(host.x + pt!.x, host.y + pt!.y);
  const dock = page.locator(`[data-world-dock="${tileId}"]`);
  await expect(dock).toBeVisible({ timeout: 5_000 });
  // The SAME xterm now lives in the dock (a DOM slot, not a texture).
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe(`[data-world-dock] .xterm`)).toBe("kept");
  // Keys typed into the docked terminal reach the shell.
  await dock.locator(".xterm-screen").click();
  await page.keyboard.type("echo WORLD_DOCK_OK");
  await page.keyboard.press("Enter");
  await expect(dock.locator(".xterm")).toContainText("WORLD_DOCK_OK", { timeout: 5_000 });
  // Esc while the terminal has the keyboard belongs to the terminal (a TUI
  // interrupt); take focus back to the panel header, then Esc undocks and the
  // surface parks again.
  await page.keyboard.press("Escape");
  await expect(dock).toHaveCount(1);
  await dock.locator("> div").first().click({ position: { x: 20, y: 10 } });
  await page.keyboard.press("Escape");
  await expect(dock).toHaveCount(0);
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe("#hm-tile-park .xterm")).toBe("kept");
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal .xterm");
});

test("a crash in the World view falls back to the canvas with every session intact", async () => {
  await toView("world");
  await page.waitForSelector("[data-world-canvas]");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:test-crash-view", { detail: { view: "world" } })));
  await page.waitForSelector(".react-flow", { timeout: 5_000 });
  expect(await activeView()).toBe("canvas");
  await expect(page.locator("[data-view-failure]")).toHaveCount(0);
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
  await expect(page.locator(".hm-term-root").filter({ hasText: "exited" })).toHaveCount(0);
});
