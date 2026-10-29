/** A live wallpaper drawn as the app draws it: its built entry served as the app serves it
 *  (`serveViewFile`: the SDK's import map, the CSP, no network) into a sandboxed frame in headless
 *  Chromium, handed a port with the views' handshake, and answered by a host that checks everything
 *  it sends as the app does (`fakeWallpaperHost`: `parseWallpaperMessage`, `wallpaperRefusal`, the
 *  protocol). The host plays the app for a moment: agents in every state, their tiles, each look and
 *  mode, the pointer and a click. The wallpaper's code runs in a sandboxed frame, as in the app, of
 *  a Chromium started as Playwright starts it, without its own OS sandbox: `hive plugins check`
 *  runs a package's code on this computer, as its tools' and widgets' draws do, so check only a
 *  package you would install.
 *
 *  Chromium is Playwright's, found where Node would find it (a `node_modules` from the working
 *  folder up, NODE_PATH, npm's global folder): this CLI ships no browser, and on a computer without
 *  one the draw is not run, and says so, rather than failed. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pageOf, serveViewFile } from "@hivemind/core/view-files";
import { PORT_HANDSHAKE } from "@hivemind/view-sdk/protocol";
import { fakeWallpaperHost, type FakeWallpaperHost } from "@hivemind/view-sdk/testing";
import { validateWallpaperManifest, WALLPAPER_MANIFEST, type WallpaperCreature, type WallpaperTile } from "@hivemind/view-sdk/wallpaper";
import { viewSdk } from "../view-sdk.js";
import { placeIn, thrown, type Problem } from "./problem.js";

/** How long it has to say `ready` once its page has loaded, and then `drawn`. */
const CONNECT_MS = 3000;
const DRAWN_MS = 3000;
/** Two sites, so the wallpaper's frame is a process of its own, as in the app. */
const APP = "https://hive-app.invalid";
const WALLPAPER = "https://hive-wallpaper.invalid";
const VIEWPORT = { w: 1280, h: 800, dpr: 1 };

/** Agents in every state, two with their tiles on the screen. */
const CREATURES: WallpaperCreature[] = [
  { id: "agent-1", agent: "claude", kind: 0.12, size: 0.9, state: "working" },
  { id: "agent-2", agent: "codex", kind: 0.47, size: 0.82, state: "needs-you" },
  { id: "agent-3", agent: null, kind: 0.81, size: 1, state: "ready" },
  { id: "agent-4", agent: "claude", kind: 0.12, size: 0.95, state: "resting" },
];
const TILES: WallpaperTile[] = [{ x0: 760, y0: 140, x1: 1180, y1: 520, id: "agent-2" }, { x0: 120, y0: 420, x1: 560, y1: 740, id: "agent-1" }];

// The few parts of Playwright used here: this CLI does not depend on it.
interface Route { request(): { url(): string }; fulfill(o: { status: number; headers?: Record<string, string>; body?: string | Buffer }): Promise<void>; abort(): Promise<void> }
interface ConsoleMessage { type(): string; text(): string; location(): { url: string } }
interface Page {
  on(event: "pageerror", cb: (e: Error) => void): void;
  on(event: "console", cb: (m: ConsoleMessage) => void): void;
  goto(url: string, o: { waitUntil: string; timeout: number }): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
}
interface Browser { newContext(o: object): Promise<{ route(url: string, cb: (r: Route) => Promise<void>): Promise<void>; newPage(): Promise<Page> }>; close(): Promise<void> }
interface Playwright { chromium: { launch(o: object): Promise<Browser> } }

/** Playwright as installed in a `node_modules` from here up, in a folder of NODE_PATH, or in npm's
 *  global folder; null when it is in none. Found by its folder, not by a resolver: Bun's ignores
 *  NODE_PATH in places. */
function playwright(): Playwright | null {
  const names = ["playwright", "playwright-core"];
  const inRoot = (root: string) => names.map((n) => path.join(root, n)).find((p) => fs.existsSync(path.join(p, "package.json")));
  const above = (dir: string): string | undefined => inRoot(path.join(dir, "node_modules")) ?? (path.dirname(dir) === dir ? undefined : above(path.dirname(dir)));
  const global = () => spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim() || null;
  const found = above(process.cwd())
    ?? (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean).map(inRoot).find(Boolean)
    ?? (() => { const g = global(); return g ? inRoot(g) : undefined; })();
  if (!found) return null;
  try { return createRequire(path.join(found, "package.json"))(found) as Playwright; } catch { return null; }
}

/** The page the app would be: the wallpaper's frame, sandboxed, and the port handed to it once it
 *  has loaded. What it says is kept for `said()`; `hear(m)` passes it the app's messages. */
const hostPage = (src: string) => `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#000}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style></head><body>
<iframe sandbox="allow-scripts" src="${src}"></iframe>
<script>
const out = [];
const frame = document.querySelector("iframe");
frame.addEventListener("load", () => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => { let json = null; try { json = JSON.stringify(e.data); } catch {} out.push(json ?? "null"); };
  window.hear = (m) => ch.port1.postMessage(m);
  frame.contentWindow.postMessage({ type: ${JSON.stringify(PORT_HANDSHAKE)} }, "*", [ch.port2]);
}, { once: true });
window.said = () => out.splice(0);
</script></body></html>`;

/** A stack or a console line from the frame, its addresses made the files they are. */
const local = (text: string, dir: string) => text.split(`${WALLPAPER}/`).join(`${path.resolve(dir)}/`);

export async function drawWallpaper(dir: string): Promise<Problem[] | { notRun: string }> {
  let entry: string;
  try {
    const m = validateWallpaperManifest(JSON.parse(fs.readFileSync(path.join(dir, WALLPAPER_MANIFEST), "utf8")));
    if (!m.ok) return { notRun: "not run: its manifest has problems" };
    entry = m.manifest.entry;
  } catch { return { notRun: "not run: its manifest has problems" }; }
  if (!fs.existsSync(path.join(dir, entry))) return { notRun: `not run: its entry ${entry} is not there; build it first` };
  const pw = playwright();
  if (!pw) return { notRun: "not run: no Chromium to draw it in. Install Playwright where Node finds it: `npm install -g playwright && npx playwright install chromium`" };
  let browser: Browser;
  try {
    // Only what Chromium needs of the person's environment.
    browser = await pw.chromium.launch({ headless: true, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  } catch (e) {
    return { notRun: `not run: Chromium did not start: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
  const fake = fakeWallpaperHost({ viewport: VIEWPORT, mode: "run", creatures: CREATURES, tiles: TILES });
  try {
    return await play(browser, fake, dir, entry);
  } finally {
    fake.close();
    await browser.close().catch(() => {});
  }
}

async function play(browser: Browser, fake: FakeWallpaperHost, dir: string, entry: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  const context = await browser.newContext({ viewport: { width: VIEWPORT.w, height: VIEWPORT.h }, deviceScaleFactor: VIEWPORT.dpr });
  // Its files as the app serves them, the app's page, and nothing else: no network.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === APP && url.pathname === "/") {
      const src = `${WALLPAPER}/${pageOf(entry)}${entry.endsWith(".js") ? `?js=${encodeURIComponent(entry)}` : ""}`;
      return route.fulfill({ status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: hostPage(src) });
    }
    if (url.origin !== WALLPAPER) return route.abort();
    const file = await serveViewFile(dir, decodeURIComponent(url.pathname.slice(1)), { js: url.searchParams.get("js"), sdk: viewSdk, own: { at: WALLPAPER, fetch: false } });
    if (file.status !== 200) return route.fulfill({ status: file.status });
    const headers = { "Content-Security-Policy": file.csp, "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*", "Content-Type": file.type };
    return route.fulfill({ status: 200, headers, body: "text" in file ? file.text : fs.readFileSync(file.file) });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(thrown("draw", { name: e.name, message: e.message, stack: local(e.stack ?? "", dir) }, dir, "it threw: ")));
  page.on("console", (m) => {
    if (m.type() !== "error" || m.location().url.startsWith(`${APP}/`)) return;
    const text = local(m.text(), dir);
    problems.push({ step: "draw", message: `it logged an error: ${text.split("\n")[0]}`, ...placeIn(text, dir) });
  });

  // The port, both ways: what the wallpaper says is checked by the fake host; what the host says
  // is passed to the frame, in order. A wedged page answers nothing, so every call is bounded.
  const grab = new EventTarget();
  const handed: { port?: MessagePort } = {};
  grab.addEventListener("message", (e) => { handed.port = (e as MessageEvent).ports[0]; });
  fake.handshake(grab);
  const port = handed.port!;
  const bounded = (expression: string) => Promise.race([page.evaluate(expression), new Promise((r) => setTimeout(r, 2000))]).catch(() => undefined);
  let passing: Promise<unknown> = Promise.resolve();
  port.onmessage = (e) => { passing = passing.then(() => bounded(`hear(${JSON.stringify(e.data)})`)); };
  /** Carry what it said to the host for `ms`, or until `done()`. */
  const pump = async (ms: number, done: () => boolean = () => false) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !done()) {
      const said = await bounded("said()");
      for (const json of Array.isArray(said) ? said : []) port.postMessage(JSON.parse(String(json)));
      await fake.settle();
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  await page.goto(`${APP}/`, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch((e: unknown) => problems.push(thrown("draw", e, dir, "its page did not load: ")));
  const ready = () => fake.received.some((m) => m.type === "ready");
  await pump(CONNECT_MS, () => ready() || problems.length > 0);
  if (!ready()) {
    if (!problems.length) problems.push({ step: "draw", message: `it did not connect within ${CONNECT_MS / 1000} s: call connectWallpaper() as its page loads` });
  } else {
    await pump(DRAWN_MS, () => fake.drawn || problems.length > 0);
    if (!fake.drawn && !problems.length) problems.push({ step: "draw", message: `it connected but drew nothing within ${DRAWN_MS / 1000} s: draw a first frame and say drawn (animate does both)` });
    // The app for a moment: the pointer in the middle, then beside agent-2's tile on its open
    // side, where it waits for the person, and a click there; the agents change, a turn ends
    // well, the look and the size change, each mode; the pointer about, a click, and gone.
    fake.point(640, 400);
    await pump(250);
    fake.point(TILES[0]!.x0 - 28, (TILES[0]!.y0 + TILES[0]!.y1) / 2);
    await pump(250);
    fake.click(TILES[0]!.x0 - 28, (TILES[0]!.y0 + TILES[0]!.y1) / 2);
    fake.send({ type: "creatures", creatures: [{ ...CREATURES[0]!, state: "needs-you" }, { ...CREATURES[1]!, state: "ready" }, CREATURES[3]!, { id: "agent-5", agent: "gemini", kind: 0.66, size: 0.86, state: "working" }] });
    fake.send({ type: "tiles", tiles: [{ ...TILES[1]!, x0: 640, x1: 1000 }], seeThrough: true });
    fake.send({ type: "done", id: "agent-1" });
    fake.send({ type: "look", look: { page: "#f6f4ee", text: "#1d2126", attention: "#b4690e", dark: false, colour: true, mono: "\"No Such Font\", monospace" } });
    fake.send({ type: "viewport", viewport: { w: 1024, h: 700, dpr: 2 } });
    for (const mode of ["still", "hold", "run"] as const) fake.send({ type: "mode", mode });
    for (const [x, y] of [[200, 200], [900, 600], [320, 640], [700, 120]] as const) fake.point(x, y);
    await pump(600);
    fake.click(700, 120);
    fake.point(0, 0, false);
    await pump(250);
    await passing;
  }
  port.close();
  // Each once: it answers every move of the pointer the same way.
  for (const why of new Set(fake.refused)) problems.push({ step: "draw", message: `the app would refuse what it sent: ${why}` });
  return problems;
}
