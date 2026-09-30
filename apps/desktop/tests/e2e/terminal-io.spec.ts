// Keys typed into a terminal reach its shell, and what the shell prints reaches the window: the
// terminal's whole path through the workspace API, as the app and, in the harness
// (playwright.harness.config.ts), as the renderer in a browser over the dev-bridge.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchWindow, type AppWindow } from "./helpers/window";

let app: AppWindow;
let page: Page;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminal-io-")));

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  app = await launchWindow({ cwd: repo, args: [`--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminal-io-ud-"))}`] });
  page = app.page;
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("keys typed into a terminal reach its shell, and what it prints reaches the window", async () => {
  await page.locator('[data-toolbar-action="terminal"]').click();
  const term = page.locator(".react-flow__node-terminal").first();
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  const marker = path.join(repo, "typed.txt");
  // The shell is up once a line typed into it runs.
  await expect.poll(async () => {
    await page.keyboard.type(`echo from-the-window-$((6*7)) > ${marker}\n`);
    return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  }, { timeout: 20_000, intervals: [500] }).toBe("from-the-window-42");
  await page.keyboard.type("echo printed-$((20+22))\n");
  // What the terminal shows (it draws on a canvas: its host element reads its screen as text).
  const screen = () => term.evaluate((el) => {
    const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
    return host?.__hmScreen() ?? "";
  });
  await expect.poll(screen, { timeout: 10_000 }).toContain("printed-42");
});
