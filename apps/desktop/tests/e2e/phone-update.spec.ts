// The phone page's service worker (crates/hive-web/www/sw.js) in plain Chromium, against a server
// in the test that answers as hive-net's pages.rs does (no-cache, an ETag per file): an open shows
// the newest build had whole at once, never waiting on the server; a build the server changed is
// fetched whole alongside and is what the next open shows.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SW = fs.readFileSync(path.resolve("../../crates/hive-web/www/sw.js"));

/** What the server serves: page `version`, whose `broken` files answer 500 and `slow` ones 1.5 s
 *  late, as they were asked; or, `quiet`, nothing at all; or, `down`, a closed connection. */
interface Served { version: string; broken: Set<string>; slow?: Set<string>; quiet: boolean; down: boolean }

let browser: Browser | undefined;
let server: http.Server | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const files = (v: string): Record<string, string> => ({
  "index.html": `<!doctype html><script type="module" src="main.js"></script><script type="module" src="part.js"></script>`,
  "main.js": `window.main = "${v}"; navigator.serviceWorker.register("sw.js");`,
  "part.js": `window.part = "${v}"; window.later = () => import("./late.js").then((m) => m.v);`,
  "late.js": `export const v = "${v}";`,
  "shell.json": `["./","late.js","main.js","part.js"]`,
  "page.sha256": `${v}\n`,
});

/** The page at /phone/, opened once and kept by its service worker, which then serves it. */
async function opened(served: Served): Promise<Page> {
  server = http.createServer((req, res) => {
    if (served.down) return req.socket.destroy();
    if (served.quiet) return;
    const name = new URL(req.url!, "http://x").pathname.replace(/^\/phone\//, "") || "index.html";
    const body = name === "sw.js" ? SW : files(served.version)[name];
    if (body === undefined || served.broken.has(name)) {
      res.writeHead(body === undefined ? 404 : 500);
      return res.end();
    }
    const tag = `"${served.version}-${name}"`;
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".html") ? "text/html" : "text/plain";
    const head = { "content-type": type, "cache-control": "no-cache", etag: tag, vary: "accept-encoding" };
    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, head);
      return res.end();
    }
    setTimeout(() => {
      res.writeHead(200, head);
      res.end(body);
    }, served.slow?.has(name) ? 1500 : 0);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/phone/#home`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return page;
}

const shown = (page: Page) => page.evaluate(() => [(window as unknown as { main: string }).main, (window as unknown as { part: string }).part]);
/** Until build `v` is had whole. */
const had = (page: Page, v: string) => expect.poll(() => page.evaluate(async (n) => (await caches.has(n)) && !!(await (await caches.open(n)).match("page.sha256")), `hive-web-${v}`)).toBe(true);
const builds = (page: Page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("hive-web-")));

test("a build the server changed is fetched whole as an open shows the one had, and the next open shows it", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  served.version = "B";
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  await had(page, "B");
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
  // Nothing new: once the page that ran it has gone, the build no page runs is dropped.
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
  await expect.poll(() => builds(page)).toEqual(["hive-web-B"]);
});

test("a new build only partly fetched is never run: the one had opens until all of the new one is", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  served.version = "B";
  served.broken.add("part.js");
  for (let i = 0; i < 3; i++) {
    await page.reload();
    expect(await shown(page)).toEqual(["A", "A"]);
  }
  served.broken.clear();
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  await had(page, "B");
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
});

test("a build still being fetched when an open finds the server back at the one had is kept, whole", async () => {
  const served: Served = { version: "A", broken: new Set(), slow: new Set(["part.js"]), quiet: false, down: false };
  const page = await opened(served);
  served.version = "B";
  await page.reload();
  served.version = "A";
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  await had(page, "B");
});

test("a page open as a new build arrives keeps getting the files of its own build, also after its worker was stopped", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  served.version = "B";
  const other = await page.context().newPage();
  await other.goto(page.url());
  await had(other, "B");
  await other.reload();
  expect(await shown(other)).toEqual(["B", "B"]);
  // The browser stops a worker left idle; what it knew of each page outlives it.
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("ServiceWorker.enable");
  await devtools.send("ServiceWorker.stopAllWorkers");
  expect(await page.evaluate(() => (window as unknown as { later(): Promise<string> }).later())).toBe("A");
  expect(await other.evaluate(() => (window as unknown as { later(): Promise<string> }).later())).toBe("B");
});

test("an open never waits on the server: gone or not answering, the build had opens at once", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  served.down = true;
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  served.down = false;
  served.quiet = true;
  const at = Date.now();
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  expect(Date.now() - at).toBeLessThan(1_500);
});
