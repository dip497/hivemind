// A Browser tile shows a web page drawn by its own renderer. When the canvas is zoomed, the page has
// to be drawn at that zoom: a page drawn at 100% and then stretched by the canvas reads blurred.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

let app: ElectronApplication;
let page: Page;
let server: Server;
let port = 0;
const root = mkdtempSync(path.join(tmpdir(), "hm-sharp-"));
// Set to a folder to keep what the screen showed at each zoom.
const SHOTS = process.env["BROWSER_SHARP_SHOTS"];

const WORDS = "amber birch cobalt delta ember fjord gravel harbor indigo juniper kestrel lantern meadow nickel orchid pebble quartz raven saffron timber umber violet willow xenon yarrow zephyr".split(" ");
// Lines that are each different and never wrap, so a piece of the screen matches one place in the page.
const LINES = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, "0")} ${WORDS.map((_w, j) => WORDS[(i * 7 + j * 3) % WORDS.length]).join(" ")}`);
const BUTTONS = ["north", "east", "south", "west"].map((id, i) => `<button id=${id} style="position:absolute;left:${80 + i * 140}px;top:340px;width:110px;height:40px">${id}</button>`).join("");
const HTML = `<!doctype html><title>sharp</title><style>body{margin:0;font:16px/25px sans-serif;color:#000;background:#fff}
#t{padding:8px 12px;white-space:pre}</style><div id=t>${LINES.join("\n")}</div>${BUTTONS}
<script>addEventListener("pointerdown", (e) => { document.title = "pressed " + (e.target.id || "nothing"); });</script>`;

test.beforeAll(async () => {
  server = createServer((_q, r) => { r.setHeader("content-type", "text/html"); r.end(HTML); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  port = (server.address() as { port: number }).port;
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
  delete env["ELECTRON_RUN_AS_NODE"];
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.evaluate(() => window.hive.settingsSet("plugins.state.tool:hivemind/web", { enabled: true }));
});
test.afterAll(async () => { await app?.close(); server?.close(); rmSync(root, { recursive: true, force: true }); });

const zoom = async () => page.locator(".react-flow__viewport").evaluate((el) => Number(/scale\(([\d.]+)\)/.exec((el as HTMLElement).style.transform)?.[1]));

const inPage = async <T,>(tileId: string, expression: string) =>
  page.evaluate(async ([id, ex]) => ((await window.hive.browserCdp(id!, "Runtime.evaluate", { expression: ex, returnByValue: true })) as { result: { value: unknown } }).result.value, [tileId, expression]) as Promise<T>;

async function openBrowser(url: string): Promise<string> {
  const before = await page.locator(".react-flow__node-browser").count();
  if (!(await page.locator(".react-flow__node-frame").count())) {
    await page.keyboard.press("6");
    await page.waitForSelector(".react-flow__node-frame");
  }
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((fid) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId: fid, kind: "browser" } })), frameId);
  await expect(page.locator(".react-flow__node-browser")).toHaveCount(before + 1);
  const tileId = (await page.locator(".react-flow__node-browser").nth(before).getAttribute("data-id"))!;
  await expect.poll(() => page.evaluate(async (id) => {
    try { await window.hive.browserCdp(id, "Runtime.evaluate", { expression: "1" }); return true; } catch { return false; }
  }, tileId), { timeout: 25_000 }).toBe(true);
  await page.evaluate(([id, u]) => window.hive.browserCdp(id!, "Page.navigate", { url: u }), [tileId, url]);
  await expect.poll(() => inPage<string>(tileId, "document.title")).toBe("sharp");
  return tileId;
}

const pageBox = (tileId: string) => page.locator(`.react-flow__node[data-id="${tileId}"] webview`).boundingBox().then((b) => b!);

/** The canvas pinched to `target` around a point, as a trackpad does it. */
async function pinchTo(target: number, at: { x: number; y: number }) {
  const pinch = (dy: number) => page.locator(".react-flow__pane").evaluate((el, [d, x, y]) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: d, clientX: x, clientY: y, ctrlKey: true, bubbles: true, cancelable: true }));
  }, [dy, at.x, at.y]);
  let gain = 0;
  for (let i = 0; i < 10 && Math.abs((await zoom()) - target) > 0.002; i++) {
    const z = await zoom();
    const dy = gain ? -Math.log2(target / z) / gain : target > z ? -40 : 40;
    await pinch(dy);
    await page.waitForTimeout(300);
    const after = await zoom();
    if (after !== z) gain = -Math.log2(after / z) / dy;
  }
  expect(await zoom()).toBeCloseTo(target, 2);
}

/** How far a piece of the screen is from the same piece of the page as its renderer drew it, at
 *  the best match: 0 is the page shown pixel for pixel, a stretched page is tens. */
async function screenAgainstPage(tileId: string): Promise<number> {
  const box = await pageBox(tileId);
  const at = { x: Math.max(0, Math.ceil(box.x)) + 20, y: Math.max(0, Math.ceil(box.y)) + 20, width: 280, height: 110 };
  const screen = await page.screenshot();
  const own = await page.evaluate(async (id) => ((await window.hive.browserCdp(id, "Page.captureScreenshot", {})) as { data: string }).data, tileId);
  return page.evaluate(async ([s64, p64, c]) => {
    const pixels = async (b64: string) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const g = new OffscreenCanvas(img.width, img.height).getContext("2d")!;
      g.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, d: g.getImageData(0, 0, img.width, img.height).data };
    };
    const s = await pixels(s64 as string);
    const p = await pixels(p64 as string);
    const r = c as { x: number; y: number; width: number; height: number };
    let best = Infinity;
    for (let oy = 0; oy < 60; oy++) for (let ox = 0; ox < 60; ox++) {
      let sum = 0;
      for (let y = 0; y < r.height; y += 2) for (let x = 0; x < r.width; x += 2) {
        sum += Math.abs(s.d[((r.y + y) * s.w + r.x + x) * 4]! - p.d[((y + oy) * p.w + x + ox) * 4]!);
      }
      best = Math.min(best, sum / ((r.width / 2) * (r.height / 2)));
    }
    return best;
  }, [screen.toString("base64"), own, at] as const);
}

test("a page on a zoomed canvas is drawn at the canvas zoom and shown pixel for pixel", async () => {
  const tileId = await openBrowser(`http://127.0.0.1:${port}/`);
  const dpr = await page.evaluate(() => devicePixelRatio);
  const width = await inPage<number>(tileId, "innerWidth");
  for (const target of [1.5, 0.97, 0.75]) {
    const box = await pageBox(tileId);
    await pinchTo(target, { x: Math.max(box.x, 0) + 60, y: Math.max(box.y, 0) + 60 });
    if (SHOTS) {
      await page.waitForTimeout(1_000);
      await page.screenshot({ path: path.join(SHOTS, `browser-sharp-zoom-${target}.png`) });
    }
    await expect.poll(() => inPage<number>(tileId, "devicePixelRatio"), { message: `drawn at canvas zoom ${target}` }).toBeCloseTo(target * dpr, 2);
    // The page keeps its width: zooming the canvas does not reflow it.
    expect(Math.abs((await inPage<number>(tileId, "innerWidth")) - width)).toBeLessThanOrEqual(1);
    expect(await screenAgainstPage(tileId)).toBeLessThan(1);
  }
  // Another site in the same tab is drawn at it too.
  await page.evaluate(([id, u]) => window.hive.browserCdp(id!, "Page.navigate", { url: u }), [tileId, `http://localhost:${port}/`]);
  await expect.poll(() => inPage<string>(tileId, "location.hostname")).toBe("localhost");
  await expect.poll(() => inPage<number>(tileId, "devicePixelRatio")).toBeCloseTo(0.75 * dpr, 2);
});

test("a press lands on what is under the pointer, and an agent's click on what it aimed at, at any zoom", async () => {
  const tileId = (await page.locator(".react-flow__node-browser").count())
    ? (await page.locator(".react-flow__node-browser").first().getAttribute("data-id"))!
    : await openBrowser(`http://127.0.0.1:${port}/`);
  // Pointer events reach a selected tile only.
  await page.locator(`.react-flow__node[data-id="${tileId}"] .tile-drag-handle`).first().click({ position: { x: 200, y: 8 } });
  for (const target of [0.5, 1, 1.7]) {
    const box = await pageBox(tileId);
    await pinchTo(target, { x: Math.max(box.x, 0) + 40, y: Math.max(box.y, 0) + 40 });
    await expect.poll(() => inPage<number>(tileId, "devicePixelRatio")).toBeCloseTo(target * (await page.evaluate(() => devicePixelRatio)), 2);
    for (const id of ["east", "south"]) {
      const r = await inPage<{ x: number; y: number; vw: number }>(tileId, `(() => { const b = document.getElementById("${id}").getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, vw: innerWidth }; })()`);
      const shown = await pageBox(tileId);
      const k = shown.width / r.vw;
      await page.mouse.click(shown.x + r.x * k, shown.y + r.y * k);
      await expect.poll(() => inPage<string>(tileId, "document.title"), { message: `pressed at zoom ${target}` }).toBe(`pressed ${id}`);
      await inPage(tileId, `document.title = "sharp"`);
      await page.evaluate(([t, x, y]) => ["mousePressed", "mouseReleased"].reduce((p, type) => p.then(() =>
        window.hive.browserCdp(t as string, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 })), Promise.resolve() as Promise<unknown>), [tileId, r.x, r.y] as const);
      await expect.poll(() => inPage<string>(tileId, "document.title"), { message: `agent click at zoom ${target}` }).toBe(`pressed ${id}`);
      await inPage(tileId, `document.title = "sharp"`);
    }
  }
});

test("the page's own zoom multiplies the canvas zoom and stays in its tile", async () => {
  const first = (await page.locator(".react-flow__node-browser").count())
    ? (await page.locator(".react-flow__node-browser").first().getAttribute("data-id"))!
    : await openBrowser(`http://127.0.0.1:${port}/`);
  const second = await openBrowser(`http://127.0.0.1:${port}/`);
  const dpr = await page.evaluate(() => devicePixelRatio);
  const box = await pageBox(first);
  await pinchTo(1.5, { x: Math.max(box.x, 0) + 40, y: Math.max(box.y, 0) + 40 });
  for (const id of [first, second]) await expect.poll(() => inPage<number>(id, "devicePixelRatio")).toBeCloseTo(1.5 * dpr, 2);
  const width = await inPage<number>(first, "innerWidth");
  await page.locator(`.react-flow__node[data-id="${first}"] input[placeholder="Search or enter address"]`).focus();
  await page.keyboard.press("Control+=");
  await expect.poll(() => inPage<number>(first, "devicePixelRatio")).toBeCloseTo(1.5 * 1.1 * dpr, 2);
  expect(await inPage<number>(first, "innerWidth")).toBeCloseTo(width / 1.1, -1);
  // The same site in another tile keeps its own zoom.
  expect(await inPage<number>(second, "devicePixelRatio")).toBeCloseTo(1.5 * dpr, 2);
  await page.keyboard.press("Control+0");
  await expect.poll(() => inPage<number>(first, "devicePixelRatio")).toBeCloseTo(1.5 * dpr, 2);
});
