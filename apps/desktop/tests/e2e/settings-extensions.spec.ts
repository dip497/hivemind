import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
let root: string;
let source: string;
let xdg: string;
const settings = async (id: string) => {
  if (!await page.locator(".settings-dialog").count()) await page.getByLabel("settings", { exact: true }).click();
  // Per-plugin pages sit in folded sidebar groups; open them the way the app links to them.
  if (id.includes(":")) await page.evaluate((p) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: p } })), id);
  else await page.locator(`[data-settings-page="${id}"]`).click();
};
const choose = async (dir: string) => {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, dir);
  await page.getByRole("button", { name: "Install from folder" }).click();
};

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-extension-settings-"));
  xdg = path.join(root, "config");
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
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).views.chrome).toEqual({});
  await page.screenshot({ path: "/tmp/hivemind-settings-views.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("settings", { exact: true })).toBeFocused();
});

test("install review, cancellation, invalid packages, replacement, disabling and removal use the real package store", async () => {
  await settings("installed");
  await choose(root);
  await expect(page.getByRole("alert")).toContainText("hivemind-view.json");
  await choose(source);
  await expect(page.getByRole("region", { name: "Review extension" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(fs.existsSync(path.join(xdg, "hivemind/views/settings-demo"))).toBe(false);
  await choose(source);
  await page.getByRole("button", { name: "Install extension", exact: true }).click();
  const pkg = page.locator('[data-community-pkg="settings-demo"]');
  await expect(pkg).toBeVisible();
  expect(fs.existsSync(path.join(xdg, "hivemind/views/settings-demo/main.js"))).toBe(true);
  await pkg.getByRole("switch").click();
  await expect(pkg.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await settings("views");
  await expect(page.getByRole("button", { name: /Settings demo/ })).toHaveCount(0);
  await settings("installed");
  await pkg.getByRole("switch").click();
  const manifestFile = path.join(source, "hivemind-view.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "1.1.0" }));
  await choose(source);
  await expect(page.getByRole("region", { name: "Review extension" })).toContainText("Replaces installed version 1.0.0");
  await page.getByRole("button", { name: "Replace extension" }).click();
  await expect(pkg).toContainText("1.1.0");
  await page.screenshot({ path: "/tmp/hivemind-settings-extensions.png" });
  await pkg.locator("summary").click();
  await pkg.getByRole("button", { name: "Remove extension", exact: true }).click();
  await pkg.getByRole("button", { name: "Keep extension" }).click();
  await expect(pkg).toBeVisible();
  await pkg.getByRole("button", { name: "Remove extension", exact: true }).click();
  await pkg.getByRole("button", { name: "Remove extension", exact: true }).click();
  await expect(pkg).toHaveCount(0);
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
  await settings("tools");
  const included = page.getByRole("region", { name: "Included tools" });
  const code = included.locator('[data-tool-plugin="hivemind/code"]');
  // The regression this guards: a built-in read as OFF because its switch asked
  // enabledPlugins, which a built-in is never in.
  await expect(code.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(included.locator('[data-tool-plugin="hivemind/issues"]').getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("region", { name: "Tools", exact: true }).locator('[data-tool-plugin="hivemind/web"]')).toHaveCount(1);

  // Switching one off disables its own tools — there is nothing to un-enable.
  await code.getByRole("switch").click();
  await expect(code.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).tools.disabledTools)
    .toEqual(["hivemind/code/editor", "hivemind/code/diff"]);
  await code.getByRole("switch").click();
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).tools.disabledTools).toEqual([]);
});
