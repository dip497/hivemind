// Browse → review → install from the plugin catalog, against a HiveHub-shaped registry built
// from the e2e fixtures (HIVEMIND_PLUGIN_INDEX), plus one agent entry added to it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildRegistry, SCOPE } from "./helpers/registry";

let app: ElectronApplication;
let page: Page;
let root: string;
let registry: string;
let xdg: string;

const CODER = "catalog-coder";
const QUEUE = `${SCOPE}/queue`, TILED = `${SCOPE}/tiled`;
const AGENT = `manifestVersion: 1
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
  await settings("plugins");
  await expect(entry("view", QUEUE)).toContainText("Queue");
  await expect(entry("agent", CODER)).toContainText("Catalog Coder");
  await page.getByRole("group", { name: "Plugin type" }).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(entry("view", QUEUE)).toHaveCount(0);
  await page.getByRole("group", { name: "Plugin type" }).getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search plugins").fill("tiled");
  await expect(page.locator("[data-catalog-plugin]")).toHaveCount(1);
  await expect(entry("view", TILED)).toBeVisible();
  await page.getByLabel("Search plugins").fill("");
});

test("a view installs only after review, and lands in the user's views", async () => {
  await settings("plugins");
  await entry("view", QUEUE).getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Queue" });
  await expect(review).toContainText("matches the checksum");
  expect(fs.existsSync(path.join(xdg, "hivemind/views", QUEUE))).toBe(false);
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("view", QUEUE)).toContainText("Installed");
  expect(fs.existsSync(path.join(xdg, "hivemind/views", QUEUE, "queue.js"))).toBe(true);
  await settings("views");
  await expect(page.getByRole("button", { name: /Queue/ }).first()).toBeVisible();
});

test("a view from the registry runs in a sandbox of its own", async () => {
  // Installed by the test above. `@` and `/` cannot be a hostname, so the view is served as
  // e2e--queue: if that mapping broke, the frame would load nothing and never say it is ready.
  await page.keyboard.press("Escape");
  await page.evaluate((mode) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode } })), QUEUE);
  const view = page.locator(`[data-community-view="${QUEUE}"]`);
  await expect(view).toHaveAttribute("data-community-ready", "1", { timeout: 20_000 });
  const src = await view.locator("iframe").getAttribute("src");
  expect(new URL(src!).host).toBe("e2e--queue");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
});

test("an agent from the catalog becomes a card, and says its CLI is not installed", async () => {
  await settings("plugins");
  await entry("agent", CODER).getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Catalog Coder" });
  await expect(review).toContainText("No code is installed");
  await expect(review.locator(".catalog-command")).toHaveText("catalog-coder");
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("agent", CODER)).toContainText("Installed");
  await settings("agents");
  await expect(page.locator(`[data-agent-card="${CODER}"]`)).toHaveAttribute("data-state", "missing");
});

test("a file that changed after it was listed is refused", async () => {
  // Not queue: an earlier test installs that one, so a refusal here would be invisible.
  fs.appendFileSync(path.join(registry, "views", "tiled", "tiled.js"), "\n// tampered");
  await settings("plugins");
  await entry("view", TILED).getByRole("button", { name: "Install" }).click();
  await expect(entry("view", TILED).getByRole("alert")).toContainText("changed after it was listed");
  expect(fs.existsSync(path.join(xdg, "hivemind/views", TILED))).toBe(false);
});
