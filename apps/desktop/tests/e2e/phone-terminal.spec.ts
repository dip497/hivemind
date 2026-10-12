// A terminal on the phone page (docs/design/phone-browser-2026-10-03.md §11.4): a shell tile on the
// computer, opened from Home on the paired page, is drawn from the screen hive-phone's core keeps of
// it in the page's wasm. A full-screen program already running draws as the computer shows it on a
// late join; what is typed on the phone reaches the shell and its echo comes back; a flood of output
// ends on the right screen; Fit to phone sizes the real terminal until the phone leaves, and it then
// takes back the size it had.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { offerPhonePairing } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "js", "terminal.js"));

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-phone-term-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** What the desktop's terminal of `tile` shows, its lines' trailing blanks cut. */
const desktopScreen = (w: Page, tile: string) => w.evaluate((id) =>
  (document.querySelector(`.react-flow__node[data-id="${id}"] .xterm`)?.parentElement as (HTMLElement & { __hmScreen?: () => string }) | null)?.__hmScreen?.() ?? "", tile);
/** The lines the phone's terminal shows, as its text layer reads them to a screen reader. */
const phoneLines = (p: Page) => p.locator('[data-screen="terminal"] [data-term-text] > div').allTextContents();

test("a shell tile opened on the paired page draws the computer's screen on a late join, takes what is typed there and shows its echo, ends a flood on the right screen, and Fit to phone sizes it until the phone leaves", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  for (const rc of [".bashrc", ".bash_profile"]) fs.writeFileSync(path.join(home, rc), "PS1='$ '\n");
  const desktop = await person(root, "desktop", repo, apps, { HOME: home, SHELL: "/bin/bash", HIVEMIND_SHELL_ENV: "0" });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());

  await offerPhonePairing(desktop);
  await desktop.locator('[data-pair-browser] [role="switch"]').click();
  const link = (await desktop.locator("[data-pair-copy]").getAttribute("title"))!;
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(link);
  await page.locator("[data-pair]").click({ timeout: 30_000 });
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  // A shell on the computer, a full-screen program running in it before the phone looks.
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const node = desktop.locator(".react-flow__node-terminal");
  await expect(node).toHaveCount(1, { timeout: 20_000 });
  const tile = (await node.getAttribute("data-id"))!;
  await expect.poll(() => desktopScreen(desktop, tile), { timeout: 20_000 }).toContain("$");
  await node.locator(".xterm").click();
  await desktop.keyboard.type("seq -f 'line %g of the file' 1 400 | less\n");
  await expect.poll(() => desktopScreen(desktop, tile), { timeout: 10_000 }).toContain("line 20 of the file");
  const computer = (await desktopScreen(desktop, tile)).split("\n").map((l) => l.trimEnd());

  // Late: the phone opens it from Home, and draws the screen the computer shows, row for row.
  const row = page.locator(`[data-tree] [data-row][data-kind="shell"]`);
  await expect(row).toHaveCount(1, { timeout: 30_000 });
  await row.click();
  await expect(page.locator('[data-screen="terminal"]')).toBeVisible();
  await expect.poll(async () => (await phoneLines(page)).slice(-computer.length).map((l) => l.trimEnd()), { timeout: 20_000 }).toEqual(computer);
  await page.screenshot({ path: testInfo.outputPath("late-join.png") });

  // Typed on the phone: less quits, and a command's echo and output come back.
  await page.locator('[data-screen="terminal"] .term-view').tap();
  await page.keyboard.press("q");
  await page.keyboard.type("echo phone-$((6*7))");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await phoneLines(page)).join("\n"), { timeout: 10_000 }).toContain("\nphone-42");
  await expect.poll(() => desktopScreen(desktop, tile)).toContain("\nphone-42");

  // Each key's echo, from the key to the frame that shows it.
  const echoes: number[] = [];
  for (const key of "abcdefghij") {
    echoes.push(await page.evaluate((k) => new Promise<number>((resolve) => {
      const text = document.querySelector('[data-screen="terminal"] [data-term-text]')!;
      const at = performance.now();
      const seen = new MutationObserver(() => {
        if (!text.textContent!.includes(`$ ${k}`)) return;
        seen.disconnect();
        requestAnimationFrame(() => resolve(performance.now() - at));
      });
      seen.observe(text, { subtree: true, childList: true, characterData: true });
      document.querySelector<HTMLTextAreaElement>("[data-term-input]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
      const input = document.querySelector<HTMLTextAreaElement>("[data-term-input]")!;
      input.value = k;
      input.dispatchEvent(new InputEvent("input", { data: k, inputType: "insertText", bubbles: true }));
    }), key));
  }
  echoes.sort((a, b) => a - b);
  console.log(`key echo: median ${echoes[5]!.toFixed(1)} ms, worst ${echoes[9]!.toFixed(1)} ms (load ${fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]})`);
  expect(echoes[5]).toBeLessThan(50);
  await page.keyboard.press("Backspace");

  // A flood, with the page's CPU a quarter as fast (a mid phone's): it ends on the screen that
  // ends it, whatever it was sent meanwhile.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.keyboard.type("seq 1 200000; echo flood-$((2*2))\n");
  await expect.poll(async () => (await phoneLines(page)).map((l) => l.trimEnd()).join("\n"), { timeout: 60_000 }).toMatch(/\n199999\n200000\nflood-4\n\$$/);

  // A full repaint, as a scroll makes one, at that CPU.
  const repaints = await page.evaluate(() => {
    const view = document.querySelector('[data-screen="terminal"] .term-view')!;
    const took: number[] = [];
    for (let i = 0; i < 30; i++) {
      const at = performance.now();
      view.dispatchEvent(new WheelEvent("wheel", { deltaY: i % 2 ? 40 : -40, bubbles: true, cancelable: true }));
      took.push(performance.now() - at);
    }
    return took.sort((a, b) => a - b);
  });
  console.log(`full repaint at 4x: median ${repaints[15]!.toFixed(2)} ms, p90 ${repaints[27]!.toFixed(2)} ms`);
  expect(repaints[15]).toBeLessThan(8);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  // Fit to phone: the real terminal takes the phone's size; the phone gone, the one it had.
  let asked = 0;
  /** The terminal's size as the shell in it says, asked from the phone. */
  const sizeOn = async (p: Page) => {
    const mark = `size${++asked}`;
    await p.keyboard.type(`clear; stty size | sed 's/^/${mark} /'\n`);
    let said = "";
    await expect.poll(async () => (said = (await phoneLines(p)).find((l) => l.startsWith(`${mark} `)) ?? ""), { timeout: 10_000 }).not.toBe("");
    return said.slice(mark.length + 1).trim();
  };
  const before = await sizeOn(page);
  await page.locator("[data-fit]").click();
  await expect(page.locator("[data-fit]")).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-screen="terminal"] .term-view').tap();
  await expect.poll(() => sizeOn(page), { timeout: 10_000 }).not.toBe(before);
  const fitted = (await sizeOn(page)).split(" ").map(Number);
  expect(fitted[1]).toBeLessThan(60);
  await page.locator('[data-screen="terminal"] [data-back]').click();
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  await row.click();
  await page.locator('[data-screen="terminal"] .term-view').tap();
  await expect.poll(() => sizeOn(page), { timeout: 10_000 }).toBe(before);
});
