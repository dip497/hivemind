// Browse → review → install from the plugin catalog, against a copy of the repo's own
// plugins/ registry (HIVEMIND_PLUGIN_INDEX), plus one agent entry added to it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
let root: string;
let registry: string;
let xdg: string;

const AGENT = `manifestVersion: 1
id: catalog-coder
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
  fs.cpSync(path.resolve("../../plugins"), registry, { recursive: true });
  fs.mkdirSync(path.join(registry, "agents", "catalog-coder"), { recursive: true });
  fs.writeFileSync(path.join(registry, "agents", "catalog-coder", "agent.yaml"), AGENT);
  const index = JSON.parse(fs.readFileSync(path.join(registry, "index.json"), "utf8"));
  index.plugins.push({
    id: "catalog-coder", type: "agent", name: "Catalog Coder", description: "A test agent from the catalog.", author: "e2e", version: "1.0.0",
    path: "agents/catalog-coder", files: [{ path: "agent.yaml", sha256: createHash("sha256").update(AGENT).digest("hex") }],
  });
  fs.writeFileSync(path.join(registry, "index.json"), JSON.stringify(index));
  execFileSync("git", ["init", "-q", root]);
  const env = {
    ...process.env, XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "hivemind", "settings.json"),
    HIVEMIND_PLUGIN_INDEX: pathToFileURL(path.join(registry, "index.json")).href,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
});

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("the catalog lists the published plugins, and search and type filters narrow it", async () => {
  await settings("plugins");
  await expect(entry("view", "orbit")).toContainText("Orbit");
  await expect(entry("agent", "catalog-coder")).toContainText("Catalog Coder");
  await page.getByRole("group", { name: "Plugin type" }).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(entry("view", "orbit")).toHaveCount(0);
  await page.getByRole("group", { name: "Plugin type" }).getByRole("button", { name: "All", exact: true }).click();
  await page.getByLabel("Search plugins").fill("solar system");
  await expect(page.locator("[data-catalog-plugin]")).toHaveCount(1);
  await expect(entry("view", "solar")).toBeVisible();
  await page.getByLabel("Search plugins").fill("");
});

test("a view installs only after review, and lands in the user's views", async () => {
  await settings("plugins");
  await entry("view", "orbit").getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Orbit" });
  await expect(review).toContainText("matches the checksum");
  expect(fs.existsSync(path.join(xdg, "hivemind/views/orbit"))).toBe(false);
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("view", "orbit")).toContainText("Installed");
  expect(fs.existsSync(path.join(xdg, "hivemind/views/orbit/orbit.js"))).toBe(true);
  await settings("views");
  await expect(page.getByRole("button", { name: /Orbit/ }).first()).toBeVisible();
});

test("an agent from the catalog becomes a card, and says its CLI is not installed", async () => {
  await settings("plugins");
  await entry("agent", "catalog-coder").getByRole("button", { name: "Install" }).click();
  const review = page.getByRole("region", { name: "Review Catalog Coder" });
  await expect(review).toContainText("No code is installed");
  await expect(review.locator(".catalog-command")).toHaveText("catalog-coder");
  await review.getByRole("button", { name: "Install" }).click();
  await expect(entry("agent", "catalog-coder")).toContainText("Installed");
  await settings("agents");
  await expect(page.locator('[data-agent-card="catalog-coder"]')).toHaveAttribute("data-state", "missing");
});

test("a file that changed after it was listed is refused", async () => {
  fs.appendFileSync(path.join(registry, "views", "solar", "solar.js"), "\n// tampered");
  await settings("plugins");
  await entry("view", "solar").getByRole("button", { name: "Install" }).click();
  await expect(entry("view", "solar").getByRole("alert")).toContainText("changed after it was listed");
  expect(fs.existsSync(path.join(xdg, "hivemind/views/solar"))).toBe(false);
});
