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
window.calls = [];
const source = {
  held: false,
  update: () => null,
  typeText: (t) => window.calls.push(["type", t]),
  typeKeys: (k) => window.calls.push(["keys", ...k]),
  fit: (c, r) => window.calls.push(["fit", c, r]),
  unfit: () => window.calls.push(["unfit"]),
  size: (c, r) => window.calls.push(["size", c, r]),
};
const app = { terminal: () => ({ source, stop: () => {} }) };
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

type Call = [string, ...unknown[]];
const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: Call[] }).calls);
const sizes = async (page: Page) => (await calls(page)).filter((c) => c[0] === "size");

test("the phone says the size it reads a terminal at as it shows one, and again as its view changes, never fitting it; Fit still fits it at once", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await terminal();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => (await sizes(page)).length).toBeGreaterThan(0);
  const [, cols, rows] = (await sizes(page)).at(-1)!;
  expect(cols).toBeGreaterThanOrEqual(20);
  expect(cols).toBeLessThan(80);
  // The keyboard comes up: fewer rows to read it in.
  await page.setViewportSize({ width: 390, height: 500 });
  await expect.poll(async () => (await sizes(page)).at(-1)?.[2]).toBeLessThan(rows as number);
  expect((await sizes(page)).at(-1)?.[1]).toBe(cols);
  expect((await calls(page)).filter((c) => c[0] === "fit")).toEqual([]);
  await page.locator("[data-fit]").click();
  const last = (await sizes(page)).at(-1)!;
  expect((await calls(page)).filter((c) => c[0] === "fit")).toEqual([["fit", last[1], last[2]]]);
});
