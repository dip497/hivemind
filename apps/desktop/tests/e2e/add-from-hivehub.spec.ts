// Searching the Add menu also searches HiveHub: what is not installed is listed under From HiveHub,
// a few at a time, and installed from there through the same review as Settings ▸ Plugins. A tool
// arrives switched off, says so, and is added from the menu once it is switched on. HiveHub's list
// in Settings draws 25 of a category and more on request. Against a HiveHub-shaped registry
// (HIVEMIND_PLUGIN_INDEX) holding the commits tool fixture and 30 more tools.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistry } from "./helpers/registry";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-add-from-hivehub-"));
const xdg = path.join(root, "config");
const COMMITS = "@example/commits";
let app: ElectronApplication;
let page: Page;

async function launch(indexUrl: string): Promise<void> {
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "hivemind", "settings.json"), HIVEMIND_SHELL_ENV: "0", HIVEMIND_PLUGIN_INDEX: indexUrl } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
}

let indexUrl = "";
test.beforeAll(async () => {
  execFileSync("git", ["init", "-q", root]);
  const hub = buildRegistry(path.join(root, "registry"));
  const fixture = path.resolve("tests/e2e/fixtures/tools/commits");
  hub.add({ id: COMMITS, type: "tool", name: "Commits", category: "git",
    files: Object.fromEntries(["hivemind-tool.json", "index.js", "icon.svg"].map((f) => [f, fs.readFileSync(path.join(fixture, f), "utf8")])) });
  for (let i = 1; i <= 30; i++) {
    hub.list({ id: `@e2e/gauge-${i}`, type: "tool", name: `Gauge ${i}`, description: "A gauge.", author: "e2e", version: "1.0.0", category: "monitoring",
      path: `tools/gauge-${i}`, files: [{ path: "hivemind-tool.json", sha256: "0".repeat(64) }] });
  }
  indexUrl = hub.indexUrl;
  await launch(indexUrl);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const menu = () => page.locator("[data-add-menu]");
/** Escape, and wait for it to be gone: a closing menu still answers to the next search. */
async function closeMenu() {
  await page.keyboard.press("Escape");
  await expect(menu()).toHaveCount(0);
}
async function search(words: string) {
  if (!await menu().count()) await page.locator('[data-toolbar-action="board"]').first().click();
  const box = menu().getByRole("textbox");
  await box.fill(words);
}

test("a search lists what HiveHub has that is not installed, five at a time", async () => {
  await search("gauge");
  const hub = menu().locator('[data-add-hub="results"]');
  await expect(hub.locator("[data-add-hub-entry]")).toHaveCount(5);
  await hub.locator("[data-show-more]").click();
  await expect(hub.locator("[data-add-hub-entry]")).toHaveCount(15);
  await closeMenu();
});

test("a tool installed from the Add menu is reviewed first, arrives switched off, and is added once switched on", async () => {
  await search("commits");
  const entry = menu().locator(`[data-add-hub-entry="tool:${COMMITS}"]`);
  await expect(menu().locator('[data-board-choice="tile:commits"]')).toHaveCount(0);
  await entry.locator("[data-install-start]").click();
  await expect(entry.locator("[data-install-review]")).toContainText("installed switched off");
  await entry.locator("[data-install-confirm]").click();
  await expect(entry).toHaveAttribute("data-state", "off");
  await expect(entry).toContainText("Installed, switched off");
  await expect(menu().locator('[data-board-choice="tile:commits"]')).toHaveCount(0);

  await entry.locator("[data-add-hub-switch-on]").click();
  const toolPage = page.locator(`[data-plugin-page="tool:${COMMITS}"]`);
  await toolPage.getByRole("switch").click();
  await expect(toolPage.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  // Gone, overlay too: until then a click on Add lands on Settings as it closes.
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  await search("commits");
  await expect(menu().locator('[data-board-choice="tile:commits"]')).toBeVisible();
  await expect(menu().locator("[data-add-hub-entry]")).toHaveCount(0);
  await closeMenu();
});

test("nothing installed or on HiveHub matching offers to make one", async () => {
  await search("zzzz nothing");
  await expect(menu().locator('[data-add-hub="none"]')).toBeVisible();
  await expect(menu().locator("[data-add-make]")).toBeVisible();
  await closeMenu();
});

test("HiveHub's list in Settings draws 25 of a category, and the rest on request", async () => {
  await page.getByLabel("settings", { exact: true }).click();
  await page.locator('[data-settings-page="plugins"]').click();
  await page.locator('[data-plugins-scope="hub"]').click();
  await page.locator('[data-plugins-kind="tool"]').click();
  const gauges = page.locator('[data-plugins-category="monitoring"]');
  await expect(gauges.locator("[data-catalog-plugin]")).toHaveCount(25);
  await gauges.locator("[data-show-more]").click();
  await expect(gauges.locator("[data-catalog-plugin]")).toHaveCount(30);
  await page.keyboard.press("Escape");
});

test("with HiveHub out of reach, the menu says so in one line and still lists what is installed", async () => {
  await app.close();
  await launch(`file://${path.join(root, "no-such-index.json")}`);
  await search("sticky");
  await expect(menu().locator('[data-add-hub="unreachable"]')).toBeVisible();
  await expect(menu().locator('[data-board-choice="widget:note"]')).toBeVisible();
});
