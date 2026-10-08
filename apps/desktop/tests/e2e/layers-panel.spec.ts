// The Layers panel as a person arranges it: pin a tile from its menu, choose in the View menu what
// is listed and how it is grouped, fold a section, and find all of it as they left it after a
// restart. The View menu is theirs (settings); pins and folds are theirs for this workspace.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-layers-"));
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_PTY_DAEMON: "0", HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
}
test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await launch();
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(3);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const panel = () => page.locator('aside[aria-label="Layers"]');
const rows = () => panel().locator("[data-layer-tile]");
const choose = async (menu: string, choice: string) => {
  await panel().locator("[data-layers-view-menu]").click();
  await page.locator(`[data-layers-view="${menu}"]`).click();
  await page.locator(`[data-layers-choice="${menu}:${choice}"]`).click();
};

test("a tile pinned from its menu leads the panel, under Pinned, and is not listed twice", async () => {
  const second = rows().nth(1);
  const id = (await second.getAttribute("data-layer-tile"))!;
  await second.hover();
  await second.locator("[data-layer-tile-menu]").click();
  await expect(page.locator("[data-layers-tile-actions]")).toBeVisible();
  await page.keyboard.press("p");
  await expect(panel().locator(`[data-layers-pinned] [data-layer-tile="${id}"]`)).toBeVisible();
  await expect(panel().locator(`[data-layer-tile="${id}"]`)).toHaveCount(1);
});

test("the hover card says what a row is", async () => {
  const row = rows().first();
  await row.hover();
  await expect(page.locator("[data-layers-card]")).toContainText((await row.innerText()).split("\n")[0]!.trim());
  await page.mouse.move(900, 500);
  await expect(page.locator("[data-layers-card]")).toHaveCount(0);
});

test("the View menu groups by status or not at all; a filter that leaves nothing says so and resets", async () => {
  await choose("groupBy", "status");
  await expect(panel().locator('[data-layers-bucket="idle"]')).toBeVisible();
  await choose("groupBy", "none");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
  await choose("status", "exited");
  // The pinned tile stays, whatever the filter.
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
  await expect(panel().locator('[data-layers-bucket="all"]')).toHaveCount(0);
  await choose("status", "all");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
});

test("pins, the View menu and a folded section are as they were left after a restart", async () => {
  await panel().locator('[data-layers-pinned] button[aria-expanded]').click();
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(0);
  await page.waitForTimeout(600); // the personal layout's debounced save
  await app.close();
  await launch();
  await expect(panel().locator("[data-layers-pinned] button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
  await panel().locator('[data-layers-pinned] button[aria-expanded]').click();
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
  // Reset to defaults: grouped by machine again, the pin kept (it is not a View choice).
  await panel().locator("[data-layers-view-menu]").click();
  await page.locator("[data-layers-reset]").click();
  await expect(panel().locator("[data-layers-bucket]")).toHaveCount(0);
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
});

test("the panel names what it does: search narrows the list, its rows start things, its heading says how it is grouped", async () => {
  await expect(panel().locator("[data-layers-view-menu]")).toHaveText(/By machine/);
  // Search: one tile's name leaves that tile.
  const name = (await rows().last().innerText()).split("\n")[0]!.trim();
  await panel().locator("[data-layers-search-toggle]").click();
  await panel().locator("[data-layers-search]").fill(name);
  await expect(rows()).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(panel().locator("[data-layers-search]")).toHaveCount(0);
  await expect(rows()).toHaveCount(3);
  // Nothing waits on the person: the bell says so.
  await expect(panel().locator("[data-layers-bell]")).toHaveAttribute("aria-label", "Nothing needs you");
  // Rows that start things.
  await panel().locator('[data-layers-action="add"]').click();
  await expect(page.locator("[data-add-menu]")).toBeVisible();
  await page.keyboard.press("Escape");
  await panel().locator('[data-layers-action="plugins"]').click();
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
  await page.keyboard.press("Escape");
});
