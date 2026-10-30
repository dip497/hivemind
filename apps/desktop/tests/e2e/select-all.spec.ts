// Select all and copy with no text field focused leave the clipboard as it was: the window's own
// text (the Layers list, each tile's name and buttons) is never copied whole, to be pasted into an
// agent. In a text field, select all is the field's, as anywhere.
import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("Ctrl+A then Ctrl+C on the canvas copies nothing; in a text field Ctrl+A selects the field's text", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-select-all-")));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".react-flow", { timeout: 30_000 });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
    await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1);
    await app.evaluate(({ clipboard }) => clipboard.writeText("what the person copied"));

    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    expect(await page.evaluate(() => String(getSelection()))).toBe("");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("what the person copied");

    await page.locator("[data-layers-search-toggle]").click();
    const search = page.locator("[data-layers-search]");
    await search.fill("frames");
    await page.keyboard.press("Control+a");
    expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6]);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
