// A program in a terminal puts text on the clipboard with OSC 52, as Claude Code in fullscreen does
// with what you select by mouse. A request to read the clipboard is told nothing.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hm-terminal-clipboard-")));

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(repo, ".user-data")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("text a program copies with OSC 52 is on the clipboard; asked to read the clipboard, it says nothing", async () => {
  await page.locator('[data-toolbar-action="board"]').click();
  await page.locator('[data-board-choice="tile:shell"]').click();
  const term = page.locator(".react-flow__node-terminal").first();
  await term.locator(".xterm-screen").click();
  const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
  await app.evaluate(({ clipboard: c }) => c.writeText("before"));
  const copied = Buffer.from("selected in the agent ✓").toString("base64");
  // Typed again until the shell is up to run it.
  await expect.poll(async () => {
    await page.keyboard.type(`printf '\\033]52;c;${copied}\\a'\n`);
    return clipboard();
  }, { timeout: 20_000, intervals: [1_000] }).toBe("selected in the agent ✓");
  const screen = () => term.evaluate((el) => ([el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined)?.__hmScreen() ?? "");
  await page.keyboard.type(`printf '\\033]52;c;?\\a'; read -t 1 -r answer; echo "read:[$answer]"\n`);
  await expect.poll(screen).toContain("read:[]");
  expect(await clipboard()).toBe("selected in the agent ✓");
});
