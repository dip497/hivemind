// A program in a terminal puts text on the clipboard with OSC 52, as Claude Code in fullscreen does
// with what you select by mouse. A request to read the clipboard is told nothing.
import { test, expect, chromium, _electron as electron, type Browser, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { freePort, openInABrowser } from "./helpers/window";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let browser: Browser | undefined;
// One app; the tests after the first also show its shell in a browser tab the app serves.
test.describe.configure({ mode: "serial" });
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
  await browser?.close();
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

const screenOf = (term: Locator) => term.evaluate((el) => ([el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined)?.__hmScreen() ?? "");

/** The app served to a browser tab, its clipboard the tab's own, with the shell opened at the desk
 *  brought into view, selected and clicked into. */
async function theTab(): Promise<{ tab: Page; there: Locator }> {
  const link = await openInABrowser(page, await freePort());
  browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(link).origin });
  const tab = await context.newPage();
  await tab.goto(link);
  await tab.waitForSelector(".react-flow", { timeout: 30_000 });
  await tab.getByRole("button", { name: "Fit to view (Esc)" }).click();
  const there = tab.locator(".react-flow__node-terminal").first();
  // Selected first: an unselected tile lets no click through to its terminal.
  await there.click();
  await there.locator(".xterm-screen").click();
  return { tab, there };
}
let shown: Promise<{ tab: Page; there: Locator }> | undefined;

test("with the session shown in a browser tab too, a program's copy goes to the screen whose input made it, not to the other", async () => {
  test.setTimeout(120_000);
  const term = page.locator(".react-flow__node-terminal").first();
  const desktopClipboard = () => app.evaluate(({ clipboard: c }) => c.readText());
  const { tab } = await (shown ??= theTab());
  const tabClipboard = () => tab.evaluate(() => navigator.clipboard.readText());
  await tab.evaluate(() => navigator.clipboard.writeText("before"));
  await app.evaluate(({ clipboard: c }) => c.writeText("before"));

  const fromTab = Buffer.from("chosen in the tab").toString("base64");
  await tab.keyboard.type(`printf '\\033]52;c;${fromTab}\\a'\n`);
  await expect.poll(tabClipboard, { timeout: 10_000 }).toBe("chosen in the tab");
  expect(await desktopClipboard()).toBe("before");

  // Long after the tab's last key, the desktop's input makes the next copy: it is the desktop's.
  await page.waitForTimeout(2_200);
  await term.locator(".xterm-screen").click();
  const fromDesktop = Buffer.from("chosen at the desk").toString("base64");
  await page.keyboard.type(`printf '\\033]52;c;${fromDesktop}\\a'\n`);
  await expect.poll(desktopClipboard, { timeout: 10_000 }).toBe("chosen at the desk");
  expect(await tabClipboard()).toBe("chosen in the tab");
});

// A one-pixel PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("in the browser tab, Ctrl+V pastes the tab's own clipboard, and a photo pasted is kept where the session runs, its path pasted", async () => {
  test.setTimeout(120_000);
  const { tab, there } = await (shown ??= theTab());
  await there.locator(".xterm-screen").click();
  await tab.evaluate(() => navigator.clipboard.writeText("echo pasted-$((40+2))"));
  await tab.keyboard.press("Control+V");
  await tab.keyboard.press("Enter");
  await expect.poll(() => screenOf(there), { timeout: 10_000 }).toContain("\npasted-42");

  await tab.keyboard.type("printf 'kept:%s:\\n' ");
  await there.locator("textarea").evaluate((input, png) => {
    const photo = new DataTransfer();
    photo.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: photo, bubbles: true, cancelable: true }));
  }, PNG);
  // Kept in the tile's own photos folder in the app's data, the same bytes, and that path typed.
  const photos = path.join(repo, ".user-data", "photos");
  const keptFiles = () => (fs.existsSync(photos) ? fs.readdirSync(photos, { recursive: true }).map(String).filter((f) => f.endsWith(".png")) : []);
  await expect.poll(keptFiles, { timeout: 10_000 }).toHaveLength(1);
  const kept = path.join(photos, keptFiles()[0]!);
  expect(fs.readFileSync(kept).equals(Buffer.from(PNG, "base64"))).toBe(true);
  await tab.keyboard.press("Enter");
  // A long path wraps on the screen: read without its line ends.
  await expect.poll(async () => (await screenOf(there)).replace(/\n/g, ""), { timeout: 10_000 }).toContain(`kept:${kept}:`);
});
