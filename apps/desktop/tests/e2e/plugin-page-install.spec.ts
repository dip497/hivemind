// A HiveHub plugin's own page installs it, through the same review as the list, and shows its
// README before it is installed. Against a HiveHub-shaped registry holding the commits tool fixture.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistry } from "./helpers/registry";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-page-install-"));
const xdg = path.join(root, "config");
const COMMITS = "@example/commits";
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q", root]);
  const hub = buildRegistry(path.join(root, "registry"));
  const fixture = path.resolve("tests/e2e/fixtures/tools/commits");
  hub.add({ id: COMMITS, type: "tool", name: "Commits", category: "git", files: {
    ...Object.fromEntries(["hivemind-tool.json", "index.js", "icon.svg"].map((f) => [f, fs.readFileSync(path.join(fixture, f), "utf8")])),
    "README.md": "# Commits\n\nThe branch's commits, newest first.\n",
  } });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "hivemind", "settings.json"), HIVEMIND_SHELL_ENV: "0", HIVEMIND_PLUGIN_INDEX: hub.indexUrl } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

test("a HiveHub plugin's page shows its README and installs it after the review", async () => {
  await page.getByLabel("settings", { exact: true }).click();
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: p } })), `plugin:tool:${COMMITS}`);
  const pluginPage = page.locator(`[data-plugin-page="tool:${COMMITS}"]`);
  await expect(pluginPage.locator(".plugin-readme")).toContainText("The branch's commits, newest first.");

  await pluginPage.getByRole("button", { name: "Install", exact: true }).click();
  await expect(pluginPage.locator("[data-install-review]")).toContainText("installed switched off");
  await pluginPage.locator("[data-install-confirm]").click();

  await expect(pluginPage.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(pluginPage.getByRole("tab", { name: "Settings" })).toBeVisible();
});
