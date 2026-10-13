// The phone's terminal (crates/hive-web/www/app/terminal.ts) in a phone-sized Chromium with no
// computer: the page's built modules (crates/hive-web/build.sh) served from www by route, the core's
// terminal stood in for by one that records what the view asks of it.
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

/** A terminal view watching a stand-in source; `window.calls` is what it was asked. */
async function terminal(deviceScaleFactor = 1): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => { throw e; });
  await page.route("http://page.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (name === "index.html") {
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"><main id="app" style="height:100vh;display:flex;flex-direction:column"></main>
<script type="module">
import { TerminalView } from "./js/terminal.js";
window.calls = [];
const source = {
  held: false,
  update: () => { const u = window.next ?? null; window.next = null; return u; },
  typeText: (t) => window.calls.push(["type", t]),
  typeKeys: (k) => window.calls.push(["keys", ...k]),
  fit: (c, r) => window.calls.push(["fit", c, r]),
  unfit: () => window.calls.push(["unfit"]),
  size: (c, r) => window.calls.push(["size", c, r]),
};
const app = { terminal: (w, t, changed) => (window.changed = changed, { source, stop: () => {} }) };
const view = new TerminalView();
view.el.style.flex = "1";
document.getElementById("app").append(view.el);
view.watch(app, "w0", "t1");
window.view = view;
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

type Call = [string, ...unknown[]];
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: Call[] }).calls);
const fits = async (page: Page) => (await calls(page)).filter((c) => c[0] === "fit" || c[0] === "unfit");

test("a terminal opens fitted to the phone, again as its view changes; Fit gives it back its own size, and so does leaving it", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-fit]")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await fits(page)).length).toBeGreaterThan(0);
  const [, cols, rows] = (await fits(page)).at(-1)!;
  expect(cols).toBeGreaterThanOrEqual(20);
  expect(cols).toBeLessThan(80);
  // The keyboard comes up: fewer rows to read it in.
  await page.setViewportSize({ width: 390, height: 500 });
  await expect.poll(async () => (await fits(page)).at(-1)?.[2]).toBeLessThan(rows as number);
  expect((await fits(page)).at(-1)?.[1]).toBe(cols);
  await page.locator("[data-fit]").click();
  await expect(page.locator("[data-fit]")).toHaveAttribute("aria-pressed", "false");
  expect((await fits(page)).at(-1)).toEqual(["unfit"]);
  await page.locator("[data-fit]").click();
  expect((await fits(page)).at(-1)?.[0]).toBe("fit");
  const before = (await fits(page)).length;
  await page.evaluate(() => (window as unknown as { view: { unwatch(): void } }).view.unwatch());
  expect((await fits(page)).slice(before)).toEqual([["unfit"]]);
  // The phone's own size is the fit, and only while fitted: none said for typing to take.
  expect((await calls(page)).filter((c) => c[0] === "size")).toEqual([]);
});

test("fitted, the phone shows every row of the size it asked for, the first included", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal(3);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => (await fits(page)).length).toBeGreaterThan(0);
  const [, cols, rows] = (await fits(page)).at(-1)! as [string, number, number];
  expect(cols, "readable on a phone whose pixels are three to a point").toBeLessThan(80);
  // The program draws a full screen at that size.
  await page.evaluate(([cols, rows]) => {
    const w = window as unknown as { next: unknown; changed(): void };
    w.next = { revision: 1, cols, rows, firstLine: 0, lineCount: rows, cursorLine: rows - 1, cursorCol: 1, cursorVisible: true,
      lines: Array.from({ length: rows }, (_, i) => ({ index: i, text: `row ${i}`, runs: new Uint8Array(0) })) };
    w.changed();
  }, [cols, rows]);
  const shown = page.locator("[data-term-text] > div");
  await expect.poll(() => shown.allTextContents()).toEqual(Array.from({ length: rows }, (_, i) => `row ${i}`));
});
