import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
let root: string;
let source: string;
let xdg: string;
const settings = async (id: string) => {
  if (!await page.locator(".settings-dialog").count()) await page.getByLabel("settings", { exact: true }).click();
  // A plugin's page is reached from Plugins; open it the way the app links to it.
  if (id.includes(":")) await page.evaluate((p) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: p } })), id);
  else await page.locator(`[data-settings-page="${id}"]`).click();
};
const choose = async (dir: string) => {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, dir);
  await page.getByRole("button", { name: "Add a view from a folder" }).click();
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-extension-settings-"));
  xdg = path.join(root, "config");
  seedAgents(xdg);
  source = path.join(root, "extension");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "hivemind-view.json"), JSON.stringify({ id: "settings-demo", name: "Settings demo", version: "1.0.0", entry: "main.js", protocol: 1, permissions: [] }));
  // An inert package is enough to exercise installation; runtime protocol behavior
  // and live docking are covered by community-view.spec.ts.
  fs.writeFileSync(path.join(source, "main.js"), "document.body.textContent = 'Settings demo';");
  execFileSync("git", ["init", "-q", root]);
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "hivemind", "settings.json") } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("settings has a focused dialog, view-specific automatic toolbar, and independent extension management", async () => {
  await settings("view:canvas");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("auto");
  await page.getByLabel("Display", { exact: true }).selectOption("bottom");
  await settings("view:windows");
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("auto");
  await settings("view:canvas");
  await expect(page.getByLabel("Display", { exact: true })).toHaveValue("bottom");
  await page.getByLabel("Display", { exact: true }).selectOption("auto");
  // The file first appears when the change is saved, which is debounced.
  const chrome = () => { try { return JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).views.chrome; } catch { return undefined; } };
  await expect.poll(chrome).toEqual({});
  await page.screenshot({ path: "/tmp/hivemind-settings-views.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("settings", { exact: true })).toBeFocused();
});

test("install review, cancellation, invalid packages, replacement, disabling and removal use the real package store", async () => {
  await settings("plugins");
  await choose(root);
  await expect(page.getByRole("alert")).toContainText("hivemind-view.json");
  await choose(source);
  await expect(page.getByRole("region", { name: "Review extension" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fs.existsSync(path.join(xdg, "hivemind/views/settings-demo"))).toBe(false);
  await choose(source);
  await page.getByRole("button", { name: "Install extension", exact: true }).click();
  const row = page.locator('[data-view-row="settings-demo"]');
  await expect(row).toBeVisible();
  expect(fs.existsSync(path.join(xdg, "hivemind/views/settings-demo/main.js"))).toBe(true);

  // Off on its page: it leaves the views to choose from, and stays listed to switch back on.
  await row.locator("[data-plugin-open]").click();
  await page.getByRole("switch", { name: "Enable Settings demo" }).click();
  await expect(page.getByRole("switch", { name: "Enable Settings demo" })).toHaveAttribute("aria-checked", "false");
  await settings("plugins");
  await expect(row).toHaveAttribute("data-state", "off");
  await expect(page.locator('[data-view-choice="settings-demo"]')).toHaveCount(0);
  await row.locator("[data-plugin-open]").click();
  await page.getByRole("switch", { name: "Enable Settings demo" }).click();
  await settings("plugins");
  await expect(row).toHaveAttribute("data-state", "ready");

  const manifestFile = path.join(source, "hivemind-view.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "1.1.0" }));
  await choose(source);
  await expect(page.getByRole("region", { name: "Review extension" })).toContainText("Replaces installed version 1.0.0");
  await page.getByRole("button", { name: "Replace extension" }).click();
  await expect(row).toContainText("1.1.0");
  await page.screenshot({ path: "/tmp/hivemind-settings-extensions.png" });

  await row.locator("[data-plugin-open]").click();
  await page.getByRole("button", { name: "Remove Settings demo", exact: true }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await page.getByRole("button", { name: "Remove Settings demo", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(fs.existsSync(path.join(xdg, "hivemind/views/settings-demo"))).toBe(false);
  expect(fs.existsSync(source)).toBe(true);
});

test("Appearance contains the former drawer controls and mounts terminal colours on demand", async () => {
  await settings("appearance");
  const pane = page.getByRole("dialog");
  await pane.locator("summary").filter({ hasText: "Background" }).click();
  await expect(pane.getByRole("radiogroup", { name: "Background", exact: true })).toBeVisible();
  await pane.getByRole("radio", { name: "Aurora", exact: true }).click();
  const glass = pane.getByRole("switch", { name: "Glass panels", exact: true });
  if (await glass.getAttribute("aria-checked") === "false") await glass.click();
  await expect(pane.getByLabel("Panel opacity", { exact: true })).toBeVisible();
  await expect(pane.getByLabel("Blur", { exact: true })).toBeVisible();
  await pane.locator("summary").filter({ hasText: "Background" }).click();
  await page.screenshot({ path: "/tmp/hivemind-settings-appearance-clean.png" });
  await expect(pane.locator('input[type="color"]')).toHaveCount(0);
  await pane.locator("summary").filter({ hasText: "Terminal colours" }).click();
  await expect(pane.getByLabel("background", { exact: true })).toBeVisible();
  await pane.locator("summary").filter({ hasText: "Terminal colours" }).click();
  await expect(pane.locator('input[type="color"]')).toHaveCount(0);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).appearance.wallpaper.kind).toBe("aurora");
  await pane.getByRole("heading", { name: "Appearance", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hivemind-settings-appearance.png" });
});

test("Tools separates what ships with the app from what you switch on", async () => {
  await settings("plugins");
  const included = page.getByRole("region", { name: "Included tools" });
  const code = included.locator('[data-tool-plugin="hivemind/code"]');
  // The regression this guards: a built-in read as OFF because its switch asked whether it was
  // switched on, which a built-in never needs to be.
  await expect(code.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(included.locator('[data-tool-plugin="hivemind/issues"]').getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: "Optional tools" }).locator('[data-tool-plugin="hivemind/web"]')).toHaveCount(1);

  // Switching one off switches off its own tools, in its record.
  const state = () => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).plugins.state["tool:hivemind/code"];
  await code.getByRole("switch").click();
  await expect(code.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(state).toEqual({ options: { editor: false, diff: false } });
  await code.getByRole("switch").click();
  await expect.poll(state).toBeUndefined();
});
