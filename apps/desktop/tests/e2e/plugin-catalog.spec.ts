// Browse → review → install from the plugin catalog, against a HiveHub-shaped registry built
// from the e2e fixtures (HIVEMIND_PLUGIN_INDEX), plus one agent entry added to it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistry, SCOPE } from "./helpers/registry";
import { pick } from "./helpers/select";
import { installedFile } from "./helpers/install";

let app: ElectronApplication;
let page: Page;
let root: string;
let registry: string;
let xdg: string;

const CODER = "catalog-coder";
const TILE_LIST = `${SCOPE}/tile-list`, PEOPLE = `${SCOPE}/people`;
const AGENT = `manifestVersion: 2
id: "${CODER}"
label: Catalog Coder
bin: catalog-coder
enabled: true
caps:
  promptDelivery: typed
  turnSignal: false
  resume: none
  supervise: human
  blockedDetection: false
install:
  url: https://catalog-coder.example.dev/install
`;

const entry = (type: string, id: string) => page.locator(`[data-catalog-plugin="${type}:${id}"]`);
const settings = async (id: string) => {
  if (!await page.locator(".settings-dialog").count()) await page.getByLabel("settings", { exact: true }).click();
  await page.locator(`[data-settings-page="${id}"]`).click();
};
/** Plugins, listing what HiveHub has; or what this machine has. */
const hub = async () => { await settings("plugins"); await page.locator('[data-plugins-scope="hub"]').click(); };
const yours = async () => { await settings("plugins"); await page.getByRole("tab", { name: "Installed", exact: true }).click(); };

test.beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plugin-catalog-"));
  xdg = path.join(root, "config");
  registry = path.join(root, "registry");
  const hub = buildRegistry(registry);
  hub.add({ id: CODER, type: "agent", name: "Catalog Coder", files: { "agent.yaml": AGENT } });
  execFileSync("git", ["init", "-q", root]);
  const env = {
    ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "hivemind", "settings.json"),
    HIVEMIND_PLUGIN_INDEX: hub.indexUrl,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("the catalog lists the published plugins, and search and type filters narrow it", async () => {
  await hub();
  await expect(entry("view", TILE_LIST)).toContainText("Tile list");
  await expect(entry("agent", CODER)).toContainText("Catalog Coder");
  await pick(page.getByRole("combobox", { name: "Kind" }), "Agents");
  await expect(entry("view", TILE_LIST)).toHaveCount(0);
  await pick(page.getByRole("combobox", { name: "Kind" }), "All kinds");
  await page.getByLabel("Search plugins").fill("people");
  await expect(page.locator("[data-catalog-plugin]")).toHaveCount(1);
  await expect(entry("view", PEOPLE)).toBeVisible();
  await page.getByLabel("Search plugins").fill("");
});

test("a view installs only after review, and lands in the user's views", async () => {
  await hub();
  await entry("view", TILE_LIST).getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Tile list" });
  await expect(review).toContainText("matches the checksum");
  expect(installedFile(xdg, TILE_LIST)).toBeNull();
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("view", TILE_LIST)).toContainText("Installed");
  expect(installedFile(xdg, TILE_LIST, "main.js")).not.toBeNull();
  await yours();
  await expect(page.locator(`[data-plugin-row="view:${TILE_LIST}"]`)).toBeVisible();
});

test("a view from the registry runs in a sandbox of its own", async () => {
  // Installed by the test above. `@` and `/` cannot be a hostname, so the view is served as
  // e2e--tile-list: if that mapping broke, the frame would load nothing and never say it is ready.
  await page.keyboard.press("Escape");
  await page.evaluate((mode) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), TILE_LIST);
  const view = page.locator(`[data-community-view="${TILE_LIST}"]`);
  await expect(view).toHaveAttribute("data-community-ready", "1", { timeout: 20_000 });
  const src = await view.locator("iframe").getAttribute("src");
  expect(new URL(src!).host).toBe("e2e--tile-list");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
});

test("an agent from the catalog becomes a card, and says its CLI is not installed", async () => {
  await hub();
  await entry("agent", CODER).getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Catalog Coder" });
  await expect(review).toContainText("No code is installed");
  await expect(review.locator(".catalog-command")).toHaveText("catalog-coder");
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("agent", CODER)).toContainText("Installed");
  await yours();
  await expect(page.locator(`[data-plugin-row="agent:${CODER}"]`)).toHaveAttribute("data-state", "missing");
});

test("a file that changed after it was listed is refused", async () => {
  // Not tile-list: an earlier test installs that one, so a refusal here would be invisible.
  fs.appendFileSync(path.join(registry, "views", "people", "main.js"), "\n// tampered");
  await hub();
  await entry("view", PEOPLE).getByRole("button", { name: "Install" }).click();
  await expect(entry("view", PEOPLE).getByRole("alert")).toContainText("changed after it was listed");
  expect(installedFile(xdg, PEOPLE)).toBeNull();
});

test("HiveHub opened again lists what it fetched a moment ago, without waiting on the index", async () => {
  await hub();
  await expect(entry("view", TILE_LIST)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".settings-dialog")).toHaveCount(0);
  const index = path.join(registry, "index.json");
  const listed = fs.readFileSync(index);
  fs.rmSync(index);
  try {
    await hub();
    await expect(entry("view", TILE_LIST)).toBeVisible();
    await expect(page.getByText("Could not load the plugin catalog")).toHaveCount(0);
  } finally {
    fs.writeFileSync(index, listed);
  }
});
