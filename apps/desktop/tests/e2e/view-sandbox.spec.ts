// What a view's frame may do: its own form submits (the frame allows forms, and its CSP still sends
// them nowhere), it fetches its own files and no other view's, and it is refused what the app's
// permission handlers keep from views, here notifications.
import { test, expect, _electron as electron, type ElectronApplication, type Page, type Frame } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";
import { stopDaemons } from "./helpers/daemons";

test.use({ trace: "off" });

const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const VIEW = path.join(APP_DIR, "tests/e2e/fixtures/views/sandbox-probe");
const NEIGHBOUR = path.join(APP_DIR, "tests/e2e/fixtures/views/sandbox-neighbour");
// Its own profile, so the view it installs is in no other spec's switcher.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewsandbox-xdg-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-viewsandbox-repo-"));
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;

let app: ElectronApplication;
let page: Page;
let view: Frame;

test.beforeAll(async () => {
  seedAgents(XDG);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const dir of [VIEW, NEIGHBOUR]) {
    const installed = spawnSync("bun", [CLI, "plugins", "install", dir, "--json"], { cwd: repo, encoding: "utf8", env: ENV });
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
  }
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: repo, env: ENV });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 20_000 });
  // A tile for the form to give its work to.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "sandbox-probe" } })));
  await page.waitForSelector('[data-community-view="sandbox-probe"][data-community-ready="1"]', { timeout: 20_000 });
  view = page.frame({ name: "hm-view:sandbox-probe" })!;
  await expect.poll(() => view.evaluate(() => document.body.dataset.ready ?? null)).toBe("1");
});

test.afterAll(async () => {
  await app?.close();
  stopDaemons(XDG);
  for (const d of [XDG, repo]) fs.rmSync(d, { recursive: true, force: true });
});

test("Enter in a view's form submits it: the view's prompt opens the app's dialog", async () => {
  const box = view.locator("input[name=work]");
  await box.click();
  await box.fill("run the tests");
  await box.press("Enter");
  await expect(page.locator("[data-prompt-dialog]")).toContainText("run the tests");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("[data-prompt-dialog]")).toHaveCount(0);
});

test("a view asking for notifications is refused", async () => {
  expect(await view.evaluate(() => (window as unknown as { askNotifications: () => Promise<string> }).askNotifications())).toBe("denied");
  expect(await view.evaluate(() => Notification.permission)).toBe("denied");
});

test("a view fetches its own files, and is refused another view's and the network", async () => {
  const read = (url: string) => view.evaluate((u) => (window as unknown as { read: (u: string) => Promise<unknown> }).read(u), url);
  expect(await read("./data.json")).toEqual({ whose: "the probe" });
  expect(await read("hm-view://sandbox-probe/data.json")).toEqual({ whose: "the probe" });
  // Served, but not to it: "refused" is the policy, where a missing file would be a status.
  expect(await read("./missing.json")).toBe("status 404");
  expect(await read("hm-view://sandbox-neighbour/data.json")).toBe("refused");
  expect(await read("https://example.com/")).toBe("refused");
});
