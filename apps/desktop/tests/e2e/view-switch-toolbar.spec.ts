// The toolbar carries a view switcher: the same views ⌘E cycles, picked by name. It says which
// workspace is shown and opens the way to another, as the list a view's own button opens does.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";
let repo = "";
const activeView = () => page.locator("[data-active-view]").first().getAttribute("data-active-view");

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-vs-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  repo = path.join(dir, "harbour-town");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: repo,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg") },
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
  const other = await page.locator('[data-view-choice][aria-checked="false"]').first().getAttribute("data-view-choice");
  await page.locator(`[data-view-choice="${other}"]`).click();

  await expect.poll(activeView).toBe(other);
  await expect(page.locator("[data-view-choice]")).toHaveCount(0); // the menu closed
  // …and back from the Layers panel's title menu, which every view has: a view may hide the toolbar.
  await page.locator("[data-layers-title]").click();
  await page.locator('[data-layers-show-as="canvas"]').click();
  await expect.poll(activeView).toBe("canvas");
  await expect(page.locator("[data-view-switch]")).toContainText("Canvas");
});

test("the views menu names the workspace shown and opens the switcher, from the toolbar and from a view's own button", async () => {
  const recent = page.locator("[data-recent-projects]");
  await page.locator("[data-view-switch]").click();
  await expect(page.locator("[data-view-menu-workspace]")).toHaveText("harbour-town");
  await page.locator("[data-switch-workspace]").click();
  await expect(recent).toBeVisible();
  await expect(page.locator("[data-view-choice]")).toHaveCount(0); // the menu closed
  await page.keyboard.press("Escape");
  await expect(recent).toHaveCount(0);

  // A view that draws its own toolbar asks for the same list (`openHostMenu("views")`), which
  // opens it where its button is.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:view-menu", { detail: { x: 600, y: 860, w: 120, h: 32 } })));
  const menu = page.locator("[data-view-menu]");
  await expect(menu.locator("[data-view-menu-workspace]")).toHaveText("harbour-town");
  await menu.locator("[data-switch-workspace]").click();
  await expect(recent).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
});
