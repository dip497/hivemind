import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-toolbar-actions-"));
const xdg = path.join(root, "config");
const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
const appDir = process.cwd();
const cli = path.resolve(appDir, "../cli/src/index.ts");
const toView = (mode: string) => page.evaluate((mode) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), mode);
const order = () => page.locator("[data-toolbar-action]").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-toolbar-action")));
const settings = async () => {
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.locator('[data-settings-page="views"]').click();
  await page.getByText("Customize actions", { exact: true }).click();
};
const close = () => page.getByRole("button", { name: "Close", exact: true }).click();
const hive = (...args: string[]) => JSON.parse(execFileSync("bun", [cli, ...args, "--json"], { env, cwd: root, encoding: "utf8" })).data;

async function launch() {
  app = await electron.launch({ args: [path.join(appDir, "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await page.waitForSelector(".react-flow");
}
test.beforeAll(launch);
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("toolbar order, visibility and labels are per-view and keep live tools", async () => {
  await expect.poll(order).toEqual(["terminal", "agent", "explorer", "diff", "issues", "frame", "theme"]);
  await expect(page.locator("[data-toolbar-label]")).toHaveCount(0);
  await page.getByTitle(/^Terminal  /).click();
  await page.waitForSelector(".xterm");
  const original = await page.locator(".xterm").elementHandle();
  await settings();
  await page.getByRole("checkbox", { name: "Terminal", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Show labels", exact: true }).check();
  await page.getByRole("button", { name: "Move Theme up", exact: true }).click();
  await page.getByRole("button", { name: "Move Theme up", exact: true }).click();
  await close();
  await expect.poll(order).toEqual(["agent", "explorer", "diff", "issues", "theme", "frame"]);
  await expect(page.locator("[data-toolbar-label]")).toHaveCount(6);
  expect(await page.locator(".xterm").evaluate((node, old) => node === old, original)).toBe(true);
  await toView("windows");
  await expect.poll(order).toEqual(["terminal", "agent", "explorer", "diff", "issues", "frame", "theme"]);
  await expect(page.locator("[data-toolbar-label]")).toHaveCount(0);
  await toView("canvas");
  await expect.poll(order).toEqual(["agent", "explorer", "diff", "issues", "theme", "frame"]);
  await original?.dispose();
});

test("CLI preferences persist and an empty toolbar has no handle; Settings restores actions independently of placement", async () => {
  // These preferences apply on the next start even without an HCP endpoint.
  await app.close();
  hive("config", "set", "views.chrome.canvas.island", '"hidden"');
  hive("config", "set", "views.toolbars.canvas.actions", "[]");
  await launch();
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await settings();
  await expect(page.getByText("No toolbar actions selected.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("hidden");
  await page.getByRole("button", { name: "Reset actions", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Show labels", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("hidden");
  await close();
  await page.getByRole("button", { name: "show tools", exact: true }).click();
  await expect.poll(order).toEqual(["terminal", "agent", "explorer", "diff", "issues", "frame", "theme"]);
});

test("selecting Browser as the only shortcut cannot activate it", async () => {
  await page.evaluate(() => window.hive.settingsSet("views.toolbars", { canvas: { actions: ["browser"] } }));
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.locator('[data-settings-page="extensions"]').click();
  await expect(page.getByRole("switch", { name: "Enable Browser", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Enable Browser", exact: true }).click();
  await close();
  const handle = page.getByRole("button", { name: "show tools", exact: true });
  if (await handle.count()) await handle.click();
  await expect.poll(order).toEqual(["browser"]);
  await page.getByTitle(/^Browser  /).click();
  await expect(page.locator(".react-flow__node-browser")).toHaveCount(1);
});
