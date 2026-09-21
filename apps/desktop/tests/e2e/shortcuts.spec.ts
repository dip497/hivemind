// The VS Code keys. Which key means which action is main's job (unit-tested in shortcuts.test.ts);
// Playwright's keys never pass through main's before-input-event, so these send the IPC main
// sends and check the renderer acts on it — and that the keys a shell needs still reach it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";
const workbenches = () => page.locator(".react-flow__node-workbench").count();
/** What main sends once it has resolved a key to an app action. */
const shortcut = (action: string) => app.evaluate(({ BrowserWindow }, a) => BrowserWindow.getAllWindows()[0]!.webContents.send("menu:shortcut", a), action);
const terminals = () => page.locator(".react-flow__node-terminal").count();
const screen = () => page.evaluate(() => [...document.querySelectorAll(".xterm")]
  .map((x) => (x.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "").join("\n"));

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-sc-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(terminals).toBe(1);
  await page.waitForTimeout(1500);
});
test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 8_000))]); } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Ctrl+Shift+` opens a terminal while a terminal has focus", async () => {
  await page.locator(".xterm").first().click();
  await shortcut("new-terminal");
  await expect.poll(terminals, { timeout: 10_000 }).toBe(2);
});

test("Ctrl+1 / Ctrl+Tab move between tiles", async () => {
  const selectedId = () => page.evaluate(() => document.querySelector(".hm-node-selected")?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
  if ((await terminals()) < 2) { await shortcut("new-terminal"); await expect.poll(terminals, { timeout: 10_000 }).toBeGreaterThanOrEqual(2); }
  await shortcut("tile:1");
  const first = await expect.poll(selectedId, { timeout: 5_000 }).not.toBeNull().then(selectedId);
  await shortcut("next-tile");
  await expect.poll(selectedId, { timeout: 5_000 }).not.toBe(first);
  const second = await selectedId();
  await shortcut("prev-tile");
  await expect.poll(selectedId, { timeout: 5_000 }).toBe(first);
  await shortcut("tile:2");
  await expect.poll(selectedId, { timeout: 5_000 }).toBe(second);
});

test("the shell keeps Ctrl+L (clear) and Ctrl+W (delete word); neither closes the tile", async () => {
  await page.locator(".hm-node-selected .xterm").click(); // the tile the camera is on
  await page.keyboard.type("echo keep-me-MARK");
  await page.keyboard.press("Enter");
  await expect.poll(screen, { timeout: 10_000 }).toContain("keep-me-MARK");
  await page.keyboard.press("Control+l"); // the shell's clear-screen — it used to toggle Layers
  await expect.poll(async () => (await screen()).split("keep-me-MARK").length - 1, { timeout: 5_000 }).toBe(0);
  const before = await terminals();
  await page.keyboard.type("ls some-word");
  await page.keyboard.press("Control+w"); // readline: delete the word — not close the tile
  await page.waitForTimeout(500);
  expect(await terminals()).toBe(before);
});

test("Ctrl+W on the canvas closes the selected tile — never a terminal you are typing in", async () => {
  await shortcut("explorer"); // a file tree, selected as it opens
  await expect.poll(workbenches, { timeout: 10_000 }).toBe(1);
  await page.keyboard.press("Control+w");
  await expect.poll(workbenches, { timeout: 5_000 }).toBe(0);
});
