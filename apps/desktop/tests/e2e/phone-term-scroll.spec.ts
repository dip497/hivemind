// The phone's terminal (crates/hive-web/www/app/terminal.ts) scrolled, in a phone-sized Chromium
// with no computer: the page's built modules (crates/hive-web/build.sh) served from www by route,
// the core's terminal stood in for by one the test feeds screens to, and that says whether the
// program takes scrolls (the core's `Screen::scroll`).
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "js", "terminal.js"));

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

/** A terminal view watching a stand-in source: `window.feed(n, from, first)` shows `n` lines, "line
 *  <from>" on, numbered from `first` as the core numbers them, 24 rows of them the screen;
 *  `window.takes` is whether the program takes scrolls; `window.scrolls` what it was sent;
 *  `window.earlier` how often it asked for more history; `window.taken()` whether the view has
 *  taken, and so drawn, the last screen fed. */
async function terminal(): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app" style="height:100vh;display:flex;flex-direction:column"></main>
<script type="module">
import { TerminalView } from "./js/terminal.js";
window.scrolls = [];
window.takes = false;
window.earlier = 0;
window.taken = () => next === null;
let next = null, revision = 0, changed = () => {};
window.feed = (n, from = 0, first = 0) => {
  revision++;
  const lines = Array.from({ length: n }, (_, i) => ({ index: first + i, text: "line " + (from + i), runs: new Uint8Array(0) }));
  next = { revision, cols: 40, rows: 24, firstLine: first, lineCount: first + n, cursorLine: first + n - 1, cursorCol: 0, cursorVisible: false, lines };
  changed();
};
const source = {
  held: false,
  update: () => { const u = next; next = null; return u; },
  typeText() {}, typeKeys() {}, fit() {}, unfit() {},
  earlier: () => { window.earlier++; },
  scroll: (lines, col, row) => { if (window.takes && lines) window.scrolls.push([lines, col, row]); return window.takes; },
  click: () => false,
};
const app = { terminal: (w, t, c) => { changed = c; return { source, stop: () => {} }; } };
const view = new TerminalView();
view.el.style.flex = "1";
document.getElementById("app").append(view.el);
view.watch(app, "w0", "t1");
window.ready = true;
</script>` });
    }
    const file = path.join(WWW, name);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(file) });
  });
  await page.goto("http://page.test/index.html");
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready);
  return page;
}

type Window_ = { feed(n: number, from?: number, first?: number): void; takes: boolean; scrolls: Array<[number, number, number]>; earlier: number; taken(): boolean };
const feed = (page: Page, n: number, from = 0, first = 0) => page.evaluate(([a, b, c]) => (window as unknown as Window_).feed(a!, b, c), [n, from, first]);
const inSight = async (page: Page) => (await page.locator("[data-term-text]").innerText()).split("\n").filter((l) => l.trim());

/** A finger dragged down the middle of the terminal by `by` CSS pixels: to earlier lines. */
async function swipeDown(page: Page, by: number): Promise<void> {
  const box = (await page.locator(".term-view").boundingBox())!;
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + 100);
  await page.mouse.down();
  for (let y = 0; y <= by; y += 20) await page.mouse.move(x, box.y + 100 + y);
  await page.mouse.up();
}

test("scrolled back, new output leaves the view where it is and offers a way back; the person's own tap, key or that button brings back the newest", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal();
  const jump = page.locator("[data-term-live]");
  const last = async () => (await inSight(page)).at(-1);
  await feed(page, 200);
  await expect.poll(last).toBe("line 199");
  await expect(jump).toBeHidden();
  await swipeDown(page, 400);
  await expect.poll(last).not.toBe("line 199");
  const earlier = await inSight(page);
  await feed(page, 201);
  await expect(jump).toBeVisible();
  expect(await inSight(page)).toEqual(earlier);
  await jump.click();
  await expect.poll(last).toBe("line 200");
  await expect(jump).toBeHidden();
  // A key from the bar is the person's input.
  await swipeDown(page, 400);
  await feed(page, 202);
  await expect(jump).toBeVisible();
  await page.locator("[data-key]").first().click();
  await expect.poll(last).toBe("line 201");
  await expect(jump).toBeHidden();
  // So is a tap, with or without new output.
  await swipeDown(page, 400);
  await expect.poll(last).not.toBe("line 201");
  await page.locator(".term-view").click();
  await expect.poll(last).toBe("line 201");
});

test("a program that takes scrolls is sent a swipe a line at a time, up for earlier, and the view stays", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal();
  await feed(page, 200);
  await expect.poll(async () => (await inSight(page)).at(-1)).toBe("line 199");
  await page.evaluate(() => { (window as unknown as Window_).takes = true; });
  await swipeDown(page, 400);
  const scrolls = await page.evaluate(() => (window as unknown as Window_).scrolls);
  const up = scrolls.reduce((sum, [n]) => sum + n, 0);
  // A line a line's height of the 400 pixels, every one of them up.
  expect(scrolls.every(([n]) => n < 0)).toBe(true);
  expect(up).toBeLessThan(-3);
  expect(up).toBeGreaterThan(-400);
  // At the cell under the finger, on the screen's rows.
  expect(scrolls.every(([, col, row]) => col >= 1 && col <= 40 && row >= 1 && row <= 24)).toBe(true);
  expect((await inSight(page)).at(-1)).toBe("line 199");
});

test("scrolled to the oldest line it holds, the page asks for earlier history, and when it comes the same lines stay in sight", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal();
  // Joined with 200 lines of history over the 24 of the screen.
  await feed(page, 224);
  await expect.poll(async () => (await inSight(page)).at(-1)).toBe("line 223");
  const earlier = () => page.evaluate(() => (window as unknown as Window_).earlier);
  await swipeDown(page, 400);
  expect(await earlier()).toBe(0);
  for (let i = 0; i < 10 && (await inSight(page))[0] !== "line 0"; i++) await swipeDown(page, 600);
  expect((await inSight(page))[0]).toBe("line 0");
  await expect.poll(earlier).toBeGreaterThan(0);
  // The screen again with 600 more lines above: drawn anew, the core numbering on from the 200 it let go.
  const shown = await inSight(page);
  await feed(page, 824, -600, 200);
  // Drawn as it was until the view takes it: looked at once it has.
  await expect.poll(() => page.evaluate(() => (window as unknown as Window_).taken())).toBe(true);
  expect(await inSight(page)).toEqual(shown);
  // Not new output: it stays there, and up from it are the earlier lines.
  await swipeDown(page, 200);
  await expect.poll(async () => (await inSight(page))[0]).toMatch(/^line -/);
});
