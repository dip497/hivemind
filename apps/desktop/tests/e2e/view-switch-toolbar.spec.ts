// The toolbar carries a view switcher: the same views ⌘E cycles, picked by name.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";
const activeView = () => page.locator("[data-active-view]").first().getAttribute("data-active-view");

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-vs-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});
test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 8_000))]); } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test("the toolbar switches the view, and shows which one you are in", async () => {
  const toggle = page.locator("[data-view-switch]");
  await expect(toggle).toContainText("Canvas");
  expect(await activeView()).toBe("canvas");

  await toggle.click();
  const choices = page.locator("[data-view-choice]");
  expect(await choices.count()).toBeGreaterThan(1);
  const other = await choices.filter({ hasNot: page.locator("svg.lucide-check") }).first().getAttribute("data-view-choice");
  await page.locator(`[data-view-choice="${other}"]`).click();

  await expect.poll(activeView).toBe(other);
  await expect(page.locator("[data-view-choice]")).toHaveCount(0); // the menu closed
  // …and back, the same way.
  await page.locator("[data-view-switch]").click();
  await page.locator('[data-view-choice="canvas"]').click();
  await expect.poll(activeView).toBe("canvas");
});
