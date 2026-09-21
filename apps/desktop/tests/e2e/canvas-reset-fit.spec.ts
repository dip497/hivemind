// "Reset tile layout" re-lays the canvas out and keeps everything on it; "Fit to view" and its
// shortcuts fit the whole canvas, even one several screens wide.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";
const zoom = () => page.evaluate(() =>
  Number(/scale\(([\d.]+)\)/.exec((document.querySelector(".react-flow__viewport") as HTMLElement).style.transform)?.[1] ?? NaN));
const counts = () => page.evaluate(() => ({
  frames: document.querySelectorAll(".react-flow__node-frame").length,
  terminals: document.querySelectorAll(".react-flow__node-terminal").length,
}));
const allOnScreen = () => page.evaluate(() => {
  const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
  return [...document.querySelectorAll(".react-flow__node-frame")].every((n) => {
    const r = n.getBoundingClientRect();
    return r.left >= pane.left - 1 && r.right <= pane.right + 1 && r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1;
  });
});

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-rf-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  // A canvas several screens wide: eight frames side by side, a shell in each.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
    await page.waitForTimeout(300);
    const id = await page.evaluate(() => { const a = [...document.querySelectorAll(".react-flow__node-frame")]; return a[a.length - 1]!.getAttribute("data-id"); });
    await page.evaluate((frameId) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId, kind: "shell" } })), id);
    await expect.poll(async () => (await counts()).terminals, { timeout: 10_000 }).toBe(i + 1);
  }
});
test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 8_000))]); } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("Fit to view shows the whole canvas, Ctrl 0 returns to 100%, Esc fits again", async () => {
  await page.getByTitle("Fit to view (Esc)").click();
  await expect.poll(allOnScreen, { timeout: 5_000 }).toBe(true);
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } }); // nothing editable focused
  await page.keyboard.press("Control+0");
  await expect.poll(zoom, { timeout: 5_000 }).toBeCloseTo(1, 2);
  await page.keyboard.press("Escape");
  await expect.poll(allOnScreen, { timeout: 5_000 }).toBe(true);
});

test("Reset tile layout keeps every frame and terminal", async () => {
  const before = await counts();
  await page.getByTitle("Reset tile layout for this project").click();
  await page.waitForTimeout(1500);
  expect(await counts()).toEqual(before);
  await expect.poll(allOnScreen, { timeout: 5_000 }).toBe(true); // …and ends with it all in view
});
