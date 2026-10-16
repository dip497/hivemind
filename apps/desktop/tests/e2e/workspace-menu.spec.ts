// The panel's title menu lists every workspace this computer holds, as a phone's Home does: two
// folders whose issues share a prefix, and one with no issues at all, are each listed. One is
// removed from this computer from there: its board goes, its folder stays; one with a terminal
// running is refused.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-workspace-menu-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication | undefined;
let page: Page;

function folder(name: string, prefix?: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  if (prefix) {
    fs.mkdirSync(path.join(repo, ".hivemind"));
    fs.writeFileSync(path.join(repo, ".hivemind", "config.yaml"), `prefix: ${prefix}\nnext_id: 1\nformat: 2\nagents: {}\n`);
  }
  return repo;
}

/** Opens the app in `repo` and starts a shell there, so the computer holds that workspace; with
 *  `shell` false, opens it alone. */
async function openIn(repo: string, shell = true): Promise<void> {
  await app?.close();
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  if (!shell) return;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
}

test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("the title menu lists each workspace here, whatever prefix its issues have", async () => {
  await openIn(folder("first", "SAME"));
  await openIn(folder("second", "SAME"));
  await openIn(folder("plain"));
  await page.locator('aside[aria-label="Layers"] [data-layers-title]').click();
  const menu = page.locator("[data-layers-workspaces]");
  for (const name of ["first", "second", "plain"]) await expect(menu.locator(`[data-layers-workspace="${name}"]`)).toHaveCount(1);
  await page.keyboard.press("Escape");
});

/** Every board this computer keeps, by file. */
const boards = (): string[] => fs.readdirSync(env.XDG_CONFIG_HOME!, { recursive: true, encoding: "utf8" }).filter((f) => /(^|\/)workspaces\/[^/]+$/.test(f));

/** From the title's menu, asks to remove the workspace `name`: the dialog it opens. */
async function askToRemove(name: string) {
  await page.locator('aside[aria-label="Layers"] [data-layers-title]').click();
  const row = page.locator(`[data-layers-workspaces] [data-layers-workspace="${name}"]`);
  await row.hover();
  await row.locator("[data-layers-workspace-remove]").click();
  return page.locator("[data-remove-workspace]");
}

test("a workspace removed from the title's menu leaves it, its board deleted and its folder kept; one with a terminal running is refused", async () => {
  const old = folder("old");
  await openIn(old, false);
  await openIn(path.join(root, "plain"), false);
  const before = boards();

  const dialog = await askToRemove("old");
  await expect(dialog).toContainText(old);
  await dialog.locator("[data-remove-workspace-confirm]").click();
  await expect(dialog).toHaveCount(0);
  expect(boards()).toHaveLength(before.length - 1);
  expect(fs.existsSync(old)).toBe(true);
  // Read again from this computer, not only taken off the list shown.
  await openIn(path.join(root, "plain"), false);
  await page.locator('aside[aria-label="Layers"] [data-layers-title]').click();
  await expect(page.locator('[data-layers-workspaces] [data-layers-workspace="plain"]')).toHaveCount(1);
  await expect(page.locator('[data-layers-workspaces] [data-layers-workspace="old"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A shell runs in "second": removing it is refused, and it stays.
  const refused = await askToRemove("second");
  await refused.locator("[data-remove-workspace-confirm]").click();
  await expect(refused.locator("[data-remove-workspace-error]")).toContainText("running");
  expect(boards()).toHaveLength(before.length - 1);
});
