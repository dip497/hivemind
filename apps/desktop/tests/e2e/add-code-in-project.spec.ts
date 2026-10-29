// A workspace opened on no project, holding a project someone added: Add opens Code in that
// project's folder, and offers it nowhere without one.
import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Code opens in the project a folderless workspace holds", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-add-code-")));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: home, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    const add = page.locator('[data-toolbar-action="board"]');
    const menu = page.locator("[data-add-menu]");
    const code = menu.locator('[data-board-choice="tile:editor"]');
    await add.click();
    await expect(code).toBeDisabled();
    await page.keyboard.press("Escape");

    await app.evaluate(({ dialog }, picked) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog; }, project);
    await page.locator('aside[aria-label="Layers"] [data-layers-action="project"]').click();
    await expect(page.locator('[data-layers-project="project"]')).toHaveCount(1);
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await add.click();
    await expect(code).toBeEnabled();
    await code.click();
    const picker = page.getByRole("dialog").filter({ hasText: "Start Code in" });
    if (await picker.isVisible().catch(() => false)) await picker.getByText("project", { exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id^="tile-editor"]')).toHaveCount(1);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
