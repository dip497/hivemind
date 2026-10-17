// Add, asked for again while the last Add is still closing, opens and is used: the closing dialog
// fades over a page that is live again, takes none of its clicks, and comes back whole.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchWindow } from "./helpers/window";

test("Add clicked as the last Add closes opens it, and what it offers is picked", async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-add-")));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-add-ud-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${ud}`] });
  try {
    const page = app.page;
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    const add = page.locator('[data-toolbar-action="board"]');
    const menu = page.locator("[data-add-menu]");
    await add.click();
    await menu.locator('[data-board-choice="tile:shell"]').click();
    // Straight after, while it fades out: a click where Add is.
    const box = (await add.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(menu).toHaveAttribute("data-state", "open");
    await menu.locator('[data-board-choice="tile:shell"]').click({ timeout: 5_000 });
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(2);
  } finally {
    await app.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
});
