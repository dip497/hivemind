// PROBE: an unselected tile must not receive keystrokes (tile-locked blocks the
// mouse; xterm disableStdin + blur must block the keyboard). Temporary.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "hm-kbd-"));
  execSync("git init -q -b main", { cwd: repo });
  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-kbd-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal", { timeout: 8_000 });
  await page.waitForTimeout(1500); // shell prompt
});

test.afterAll(async () => { await app?.close(); });

// Is the xterm textarea the focused element + is stdin enabled?
const termFocused = () => page.evaluate(() => {
  const ta = document.querySelector(".react-flow__node-terminal .xterm-helper-textarea");
  return !!ta && document.activeElement === ta;
});
const wrapperLocked = () => page.locator(".react-flow__node-terminal > div").first().evaluate((el) => el.classList.contains("tile-locked"));

test("an unselected terminal is locked + blurred (no keyboard); selecting re-enables", async () => {
  const term = page.locator(".react-flow__node-terminal").first();

  // 1) selected on spawn — content live, xterm focused, not locked.
  await page.waitForTimeout(500);
  expect(await wrapperLocked(), "selected tile not locked").toBe(false);
  await term.locator(".xterm-screen").click();
  await page.waitForTimeout(300);
  expect(await termFocused(), "selected terminal is focused").toBe(true);

  // 2) deselect via the pane → locked + blurred (keys can't reach it).
  await page.mouse.click(5, 200);
  await page.waitForTimeout(400);
  expect(await wrapperLocked(), "unselected tile is locked").toBe(true);
  expect(await termFocused(), "unselected terminal is blurred").toBe(false);
  // typing now goes nowhere near the terminal.
  await page.keyboard.type("should-not-reach-terminal");
  await page.waitForTimeout(200);
  expect(await termFocused(), "still blurred after typing").toBe(false);

  // 3) reselect via the header (always live) → unlocked; content is live again
  //    so clicking it focuses the terminal (keyboard works once selected).
  await term.locator(".tile-drag-handle").first().click();
  await page.waitForTimeout(400);
  expect(await wrapperLocked(), "reselected tile unlocked").toBe(false);
  await term.locator(".xterm-screen").click();
  await page.waitForTimeout(300);
  expect(await termFocused(), "selected terminal can take focus again").toBe(true);
});
