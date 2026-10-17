// The phone page opened whole (crates/hive-web/www, built by build.sh) in a phone-sized Chromium at a
// quarter of the CPU, paired with a computer it never reaches: each frame from the first shows at
// most one screen, and Start is usable from what it was told last, within 500 ms.
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const WWW = path.resolve("../../crates/hive-web/www");
const built = () => fs.existsSync(path.join(WWW, "main.js")) && fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm"));
const PAGE = "http://localhost/phone/";
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", wasm: "application/wasm", woff2: "font/woff2", json: "application/json", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json" };

let browser: Browser | undefined;
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

const claude = { id: "claude", label: "Claude Code", options: [{ id: "mode", label: "Permission mode", values: ["plan"] }] };
/** What this browser keeps once paired and once Start was answered. */
const KEPT = {
  paired: { with: { device: "c".repeat(64), name: "desk", relay: null, kind: "app" }, certificate: null, network: null, admission: "" },
  first: { shown: { needs: [], working: [], pinned: [], machines: [], tree: [] }, overview: { agents: [], needs: [], working: 0 } },
  "start-kept": { held: [{ workspace: "w0", name: "api" }], places: { w0: { machines: [{ id: "", name: "desk", programs: [claude], folders: [{ path: "/home/p/api", name: "api", kind: "project", frame: "f-api" }] }] } } },
};

/** The page as kept above, opened again on `hash`; `window.seen` is how many screens each frame showed,
 *  `window.tabs` whether one showed the tab bar, `window.usable` when Start could first be pressed. */
async function reopened(hash: string): Promise<Page> {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.route(`${PAGE}**`, (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\/phone\//, "") || "index.html";
    const file = path.join(WWW, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: TYPES[name.split(".").pop()!] ?? "application/octet-stream", body: fs.readFileSync(file) });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { seen: number[]; tabs?: boolean; usable?: number };
    w.seen = [];
    const frame = () => {
      w.seen.push([...document.querySelectorAll("[data-screen]")].filter((s) => s.checkVisibility()).length);
      if (document.querySelector("nav.tabs")?.checkVisibility()) w.tabs = true;
      const go = document.querySelector<HTMLButtonElement>("[data-start-go]");
      const said = document.querySelector("[data-start-summary]")?.textContent ?? "";
      if (w.usable === undefined && go?.checkVisibility() && !go.disabled && said.startsWith("Claude Code · api")) w.usable = performance.now();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goto(PAGE);
  await page.evaluate((kept) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("hive-web", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kept");
    open.onsuccess = () => {
      const tx = open.result.transaction("kept", "readwrite");
      for (const [key, value] of Object.entries(kept)) tx.objectStore("kept").put(value, key);
      tx.oncomplete = () => (open.result.close(), resolve());
      tx.onerror = () => reject(tx.error);
    };
  }), KEPT);
  await page.evaluate((h) => history.replaceState(null, "", h), hash);
  const devtools = await page.context().newCDPSession(page);
  await devtools.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.reload();
  return page;
}

type Seen = { seen: number[]; tabs?: boolean; usable?: number };

test("opened on Start, no frame shows two screens, and Start is usable within 500 ms at a quarter of the CPU, its computer not yet reached", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await reopened("#start");
  await expect.poll(() => page.evaluate(() => (window as unknown as Seen).usable), { timeout: 10_000 }).toBeDefined();
  const { seen, tabs, usable } = await page.evaluate(() => { const w = window as unknown as Seen; return { seen: w.seen, tabs: w.tabs, usable: w.usable }; });
  expect(Math.max(...seen)).toBeLessThanOrEqual(1);
  expect(tabs, "Start has no tab bar, in no frame").toBeUndefined();
  expect(usable).toBeLessThan(500);
  await expect(page.locator("[data-start-error]")).toHaveCount(0);
  // Pressed before the computer is reached, it waits for it.
  await page.locator("[data-start-go]").click();
  await expect(page.locator("[data-notice]")).toBeHidden();
  await expect(page.locator("[data-start-go]")).toBeDisabled();
});

test("opened on Home, no frame shows two screens", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  const page = await reopened("#home");
  await expect(page.locator('[data-screen="home"]')).toBeVisible();
  await page.waitForTimeout(300);
  const { seen } = await page.evaluate(() => { const w = window as unknown as Seen; return { seen: w.seen, usable: w.usable }; });
  expect(Math.max(...seen)).toBeLessThanOrEqual(1);
});

// conformance/pairing.json's first link: Priya's desktop.
const LINK = "hivemind://pair/eyJ2IjoxLCJkZXZpY2UiOiJjN2I2OTdiOTJmYzYzYTJkZDY2MGY2ZjAyZjJjZTMyZWI0YTg0MjgzOWNiZTQyMTM4NDVlM2I0MzkwZjQ0NmMzIiwiYWRkcnMiOlsiMTkyLjE2OC4xLjIwOjQxNjQxIiwiW2ZkMDA6OjIwXTo0MTY0MSJdLCJyZWxheSI6bnVsbCwiY29kZSI6ImFtYmVyLWNlbGxhci1oZWxtZXQtbGVtb24tc2FsbW9uLXppcHBlciIsIm5hbWUiOiJQcml5YSdzIGRlc2t0b3AiLCJraW5kIjoiYXBwIn0";

test("opened with a pairing link, it shows that link, not the page's address; until the link is read, Pair says it is starting and cannot be pressed; read, it names the computer and can", async () => {
  test.skip(!built(), "no page build: run crates/hive-web/build.sh");
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // The wasm held back: what shows before it is read.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${PAGE}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.replace(/^\/phone\//, "") || "index.html";
    const file = path.join(WWW, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404 });
    if (name.endsWith(".wasm")) await held;
    return route.fulfill({ contentType: TYPES[name.split(".").pop()!] ?? "application/octet-stream", body: fs.readFileSync(file) });
  });
  await page.goto(`${PAGE}#pair=${encodeURIComponent(LINK)}&name=Phone`);
  const pair = page.locator("[data-pair]");
  await expect(pair).toBeVisible();
  await expect(page.locator("[data-pair-link]")).toHaveValue(LINK);
  await expect(pair).toBeDisabled();
  await expect(pair).toHaveText("Starting…");
  release();
  await expect(page.locator('[data-screen="pair"] h1')).toHaveText("Pair with Priya's desktop?");
  await expect(pair).toBeEnabled();
  await expect(pair).toHaveText("Pair");
  await expect(page.locator("[data-pair-link]")).toHaveValue(LINK);
  await expect(page.locator("[data-pair-name]")).toHaveValue("Phone");
});
