// The panel's title menu lists every workspace this computer holds, as a phone's Home does: two
// folders whose issues share a prefix, and one with no issues at all, are each listed.
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

/** Opens the app in `repo` and starts a shell there, so the computer holds that workspace. */
async function openIn(repo: string): Promise<void> {
  await app?.close();
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
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
});
