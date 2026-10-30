// The phone page kept open, as a phone keeps it, while its server gets a new build: coming back
// into view, it opens the new build at once when nothing typed would be lost, and else offers it.
// Served whole (crates/hive-web/www, built by build.sh) by a server of its own, as hive-net serves it.
import { test, expect, chromium, type Browser } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "main.js")) && fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm"));
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", wasm: "application/wasm", woff2: "font/woff2", json: "application/json", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" };

let browser: Browser | undefined;
let server: http.Server | undefined;
test.afterEach(async () => {
  await browser?.close();
  server?.close();
});

test("kept open while its server gets a new build: opened again at once, or offered while something is typed", async () => {
  test.skip(!built(), "needs the phone page built (crates/hive-web/build.sh)");
  // The server's build, as page.sha256 names it; changed below, as a deploy changes it.
  let build = fs.readFileSync(path.join(WWW, "page.sha256"), "utf8").trim();
  server = http.createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/phone\//, "") || "index.html";
    if (name === "page.sha256") return res.writeHead(200, { "content-type": "text/plain" }).end(build);
    const file = path.join(WWW, name);
    if (!file.startsWith(WWW) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[name.split(".").pop()!] ?? "application/octet-stream" }).end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const at = `http://localhost:${(server.address() as AddressInfo).port}/phone/`;
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(at);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, undefined, { timeout: 30_000 });
  const backInView = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const sameDocument = () => page.evaluate(() => (window as unknown as { kept?: number }).kept === 1);
  await page.evaluate(() => { (window as unknown as { kept: number }).kept = 1; });

  // Nothing new: it stays as it is.
  await backInView();
  await page.waitForTimeout(1500);
  expect(await sameDocument()).toBe(true);

  // Something typed would be lost: offered, and the page is left as it is.
  build = "b".repeat(64);
  // What was typed into a field, wherever it is on the page.
  const field = page.locator("textarea").first();
  const type = (text: string) => field.evaluate((f: HTMLTextAreaElement, t) => { f.value = t; f.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await type("half a link");
  await backInView();
  const offer = page.locator("[data-page-newer]");
  await expect(offer).toBeVisible({ timeout: 20_000 });
  expect(await sameDocument()).toBe(true);
  await expect(field).toHaveValue("half a link");

  // Nothing typed: opened again at once, on the new build.
  build = "c".repeat(64);
  await type("");
  await backInView();
  await expect.poll(sameDocument, { timeout: 20_000 }).toBe(false);
  await expect(page.locator("[data-page-newer]")).toHaveCount(0);
});
