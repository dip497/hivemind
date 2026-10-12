// The phone page's service worker (crates/hive-web/www/sw.js) in plain Chromium, against a server
// in the test that answers as hive-net's pages.rs does (no-cache, an ETag per file): a page the
// server changed is the one the next open shows, whole, and with the server not answering, the page
// as last fetched opens.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SW = fs.readFileSync(path.resolve("../../crates/hive-web/www/sw.js"));

/** What the server serves: page `version`, whose `broken` files answer 500; or, `quiet`, nothing at
 *  all; or, `down`, a closed connection. */
interface Served { version: string; broken: Set<string>; quiet: boolean; down: boolean }

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
    res.writeHead(200, head);
    res.end(body);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server!.once("listening", r));
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/phone/#home`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return page;
}

const shown = (page: Page) => page.evaluate(() => [(window as unknown as { main: string }).main, (window as unknown as { part: string }).part]);

test("a page the server changed is the one the next reload opens, every file of it", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  served.version = "B";
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
});

test("a new page only partly fetched is never run: the page as it was opens until all of the new one is had", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  served.version = "B";
  served.broken.add("part.js");
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  await page.reload();
  expect(await shown(page)).toEqual(["A", "A"]);
  // What was had of it is not kept.
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("hive-web-")).length)).toBe(1);
  served.broken.clear();
  await page.reload();
  expect(await shown(page)).toEqual(["B", "B"]);
});

test("a page open as a new one arrives keeps getting the files of its own build, also after its worker was stopped", async () => {
  const served: Served = { version: "A", broken: new Set(), quiet: false, down: false };
  const page = await opened(served);
  served.version = "B";
  const other = await page.context().newPage();
  await other.goto(page.url());
  expect(await shown(other)).toEqual(["B", "B"]);
  // The browser stops a worker left idle; what it knew of each page outlives it.
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("ServiceWorker.enable");
  await devtools.send("ServiceWorker.stopAllWorkers");
  expect(await page.evaluate(() => (window as unknown as { later(): Promise<string> }).later())).toBe("A");
  expect(await other.evaluate(() => (window as unknown as { later(): Promise<string> }).later())).toBe("B");
});

test("with the server gone or not answering, the page opens as last fetched, within a few seconds", async () => {
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
  expect(Date.now() - at).toBeLessThan(8_000);
});
