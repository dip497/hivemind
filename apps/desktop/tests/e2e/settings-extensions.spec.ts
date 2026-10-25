import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";
import { pick } from "./helpers/select";
import { installedFile } from "./helpers/install";

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
  await page.locator("[data-add-plugin]").click();
  await page.getByRole("menuitem", { name: "Add from a folder" }).click();
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

// First in the file: it needs Settings never opened yet.
test("Settings' code is fetched while the app is idle, so its first open shows the page at once", async () => {
  const cdp = await page.context().newCDPSession(page);
  const scripts: string[] = [];
  cdp.on("Debugger.scriptParsed", (e) => scripts.push(e.url));
  // Enabling replays every script parsed so far.
  await cdp.send("Debugger.enable");
  const chunk = () => scripts.find((u) => /settings-panels-[^/]*\.js$/.test(u)) ?? "";
  await expect.poll(chunk, { message: "Settings' chunk is fetched before anyone opens it" }).toMatch(/settings-panels/);
  await cdp.send("Debugger.disable");
  // The same module record: resolves once it has run; the timeout lets the app's own callbacks finish.
  await page.evaluate(async (u) => { await import(u); await new Promise((r) => setTimeout(r)); }, chunk());
  // What the dialog holds in the first frame it is on screen.
  const firstFrame = page.evaluate(() => new Promise<string>((resolve) => {
    const seen = new MutationObserver(() => {
      const dialog = document.querySelector(".settings-dialog");
      if (!dialog) return;
      seen.disconnect();
      resolve(dialog.querySelector("[data-preset-select]") ? "the page" : "no page yet");
    });
    seen.observe(document.body, { childList: true, subtree: true });
    window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "appearance" } }));
  }));
  expect(await firstFrame).toBe("the page");
  await expect(page.locator(".settings-dialog [data-preset-select]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings has a focused dialog, view-specific automatic toolbar, and independent extension management", async () => {
  await settings("view:canvas");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Display", { exact: true })).toHaveText(/^Automatic/);
  await pick(page.getByLabel("Display", { exact: true }), "Bottom");
  await settings("view:windows");
  await expect(page.getByLabel("Display", { exact: true })).toHaveText(/^Automatic/);
  await settings("view:canvas");
  await expect(page.getByLabel("Display", { exact: true })).toHaveText("Bottom");
  await pick(page.getByLabel("Display", { exact: true }), /^Automatic/);
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
  await expect(page.getByRole("region", { name: "Review Settings demo" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(installedFile(xdg, "settings-demo")).toBeNull();
  await choose(source);
  await page.locator("[data-folder-install-do]").click();
  const row = page.locator('[data-plugin-row="view:settings-demo"]');
  await page.locator('[data-plugins-kind="view"]').click();
  await expect(row).toBeVisible();
  expect(installedFile(xdg, "settings-demo", "main.js")).not.toBeNull();

  // Off on its page: it leaves the views to choose from, and stays listed to switch back on.
  await row.locator("[data-plugin-open]").click();
  await page.getByRole("switch", { name: "Enable Settings demo" }).click();
  await expect(page.getByRole("switch", { name: "Enable Settings demo" })).toHaveAttribute("aria-checked", "false");
  await settings("plugins");
  await expect(row).toHaveAttribute("data-state", "off");
  await expect(row.locator("[data-plugin-badge]")).toHaveText("Off");
  await row.locator("[data-plugin-open]").click();
  await page.getByRole("switch", { name: "Enable Settings demo" }).click();
  await settings("plugins");
  await expect(row).toHaveAttribute("data-state", "on");

  const manifestFile = path.join(source, "hivemind-view.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, version: "1.1.0" }));
  await choose(source);
  await expect(page.getByRole("region", { name: "Review Settings demo" })).toContainText("1.0.0 → 1.1.0");
  await page.locator("[data-folder-install-do]").click();
  await page.screenshot({ path: "/tmp/hivemind-settings-extensions.png" });

  await row.locator("[data-plugin-open]").click();
  await expect(page.locator('[data-plugin-page="view:settings-demo"] .plugin-page-meta')).toContainText("v1.1.0");
  await page.getByRole("button", { name: "Remove Settings demo", exact: true }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await page.getByRole("button", { name: "Remove Settings demo", exact: true }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
  await expect(row).toHaveCount(0);
  expect(installedFile(xdg, "settings-demo")).toBeNull();
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
  // The accent's own colour well is always there; the terminal colours' wells only while open.
  const terminalWells = pane.locator('input[type="color"]:not([data-accent-custom])');
  await expect(terminalWells).toHaveCount(0);
  await pane.locator("summary").filter({ hasText: "Terminal colours" }).click();
  await expect(pane.getByLabel("background", { exact: true })).toBeVisible();
  await expect(terminalWells).not.toHaveCount(0);
  await pane.locator("summary").filter({ hasText: "Terminal colours" }).click();
  await expect(terminalWells).toHaveCount(0);
  await expect.poll(() => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).appearance.wallpaper.kind).toBe("aurora");
  await pane.getByRole("heading", { name: "Appearance", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hivemind-settings-appearance.png" });
});

test("Tools: the ones that ship are on, an optional one is off, and one is switched on its own page", async () => {
  await settings("plugins");
  await page.locator('[data-plugins-kind="tool"]').click();
  const tool = (id: string) => page.locator(`[data-plugin-row="tool:${id}"]`);
  // The regression this guards: a built-in read as OFF because its state asked whether it was
  // switched on, which a built-in never needs to be.
  await expect(tool("@hivemind/code")).toHaveAttribute("data-state", "on");
  await expect(tool("@hivemind/issues")).toHaveAttribute("data-state", "on");
  await expect(tool("@hivemind/web")).toHaveAttribute("data-state", "off");

  // Switching one off switches off its own tools, in its record.
  const state = () => JSON.parse(fs.readFileSync(path.join(xdg, "hivemind/settings.json"), "utf8")).plugins.state["tool:@hivemind/code"];
  await tool("@hivemind/code").click();
  const on = page.getByRole("switch", { name: "Enable Code", exact: true });
  await expect(on).toHaveAttribute("aria-checked", "true");
  await on.click();
  await expect(on).toHaveAttribute("aria-checked", "false");
  await expect.poll(state).toEqual({ options: { editor: false } });
  await settings("plugins");
  await expect(tool("@hivemind/code")).toHaveAttribute("data-state", "off");
  await tool("@hivemind/code").click();
  await on.click();
  await expect.poll(state).toBeUndefined();
});

test("Settings opened at a section starts with the keyboard on that section", async () => {
  if (await page.locator(".settings-dialog").count()) await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  await expect(page.locator('[data-settings-page="plugins"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
