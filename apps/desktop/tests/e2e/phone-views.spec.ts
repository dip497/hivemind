// Views on the phone in a browser (docs/design/phone-browser-2026-10-03.md §11.6): the computer
// offers its views that work on a phone; the paired page lists them under Views and shows one in a
// frame on an origin of its own (`hive-net serve --views`). A view that shows the board's widgets
// draws them there, and a press on the phone reaches the widget's code on the computer. A hostile
// view's attempts on what is the page's (its window, the device key, its service worker, its server,
// its address, cookies) fail, and what one view leaves the next never finds.
import { test, expect, chromium, type Browser, type ElectronApplication } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { connectPage, offerToConnect } from "./helpers/phone";
import { addFromMenu } from "./helpers/board";
import { stopDaemons } from "./helpers/daemons";
import { installPlugin } from "./helpers/install";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "js", "views.js"));
const FIXTURES = path.resolve("tests/e2e/fixtures/views");

// A widget whose button counts its presses, in what it keeps.
const COUNTER = `
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: (hive.state && hive.state.n) || 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", draw);
hive.on("action", (a) => { if (a === "inc") { hive.setState({ ...(hive.state || {}), n: ((hive.state && hive.state.n) || 0) + 1 }); draw(); } });
`;

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-views-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("the phone page lists the computer's phone views and shows one on its own origin: a widget drawn there is pressed on the computer, and a hostile view reaches nothing of the page's nor what a view before it left", async ({}, testInfo) => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const config = path.join(root, "desktop", "hivemind");
  for (const view of ["widget-viewer", "phone-hostile", "phone-probe"]) installPlugin(path.dirname(config), path.join(FIXTURES, view));
  const counterSource = path.join(root, "src", "counter");
  fs.mkdirSync(counterSource, { recursive: true });
  fs.writeFileSync(path.join(counterSource, "widget.json"), JSON.stringify({ name: "Counter" }));
  fs.writeFileSync(path.join(counterSource, "widget.js"), COUNTER);
  installPlugin(path.dirname(config), counterSource);
  const desktop = await person(root, "desktop", repo, apps, { HOME: home });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  await desktop.locator('[data-toolbar-action="board"]').first().click();
  await desktop.locator('[data-board-choice="widget:counter"]').click();
  await expect(desktop.locator('[data-widget-layer] [data-widget="counter"]')).toContainText("presses", { timeout: 10_000 });
  const presses = () => desktop.evaluate((r) => (window.hive.workspaceObjectsSync(r) as Array<{ kind: string; state?: { n?: number } }>).find((o) => o.kind === "widget")?.state?.n ?? 0, repo);

  const link = await offerToConnect(desktop, true);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("console", (m) => console.log(`phone: ${m.text()}`));
  // Where a view could send what it was shown.
  const leaks: string[] = [];
  context.on("request", (r) => { if (r.url().includes("/leak")) leaks.push(r.url()); });
  await page.goto(link);
  await connectPage(page, desktop);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  // Views lists those that work on a phone, each under its workspace.
  await page.locator('[data-tab="views"]').click();
  const rows = page.locator("[data-views] [data-view]");
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  expect((await rows.evaluateAll((r) => r.map((e) => e.getAttribute("data-view")))).sort()).toEqual(["phone-hostile", "phone-probe", "widget-viewer"]);

  // The widget, drawn by a view on the phone; its button pressed there, counted on the computer.
  await page.locator('[data-view="widget-viewer"]').click();
  const frame = page.locator('[data-view-frame="widget-viewer"]');
  await expect(frame).toHaveAttribute("src", new RegExp(`^${net.views!}/\\?s=`));
  const viewer = page.frameLocator('[data-view-frame="widget-viewer"]').frameLocator("iframe[data-view]");
  const counter = viewer.locator('[data-widget="counter"]');
  await expect(counter).toContainText("Counter", { timeout: 30_000 });
  await expect(viewer.locator("body")).toHaveAttribute("data-capabilities", "workspace:widgets");
  await page.screenshot({ path: testInfo.outputPath("widget-viewer.png") });
  await expect(counter).toHaveAttribute("data-n", "0");
  await counter.getByRole("button", { name: "Press" }).click();
  await expect.poll(presses, { timeout: 15_000 }).toBe(1);
  await expect(counter).toHaveAttribute("data-n", "1");
  // A note written on the computer, which draws nothing of its own: the board's change alone
  // brings it to the phone.
  await addFromMenu(desktop, "note", "from the computer");
  await expect(viewer.locator('[data-widget="note"]')).toHaveAttribute("data-text", "from the computer");
  await page.locator('[data-screen="view"] [data-back]').click();

  // The hostile view, twice: nothing of the page's reached, nothing left from the first.
  for (const time of [1, 2]) {
    await page.locator('[data-view="phone-hostile"]').click();
    const body = page.frameLocator('[data-view-frame="phone-hostile"]').frameLocator("iframe[data-view]").locator("body");
    await expect(body).toHaveAttribute("data-done", "1", { timeout: 30_000 });
    const tried = await body.evaluate((b) => ({ ...b.dataset }));
    console.log(`hostile view, time ${time}:`, JSON.stringify(tried));
    expect(tried).toMatchObject({
      leftovers: "none", window: "blocked", storage: "blocked", deviceKey: "blocked", serviceWorker: "blocked",
      server: "blocked", socket: "blocked", unruled: "blocked", otherView: "blocked",
    });
    // It tried to take the page to another address, then its own frame to another host.
    expect(new URL(page.url()).hash).toMatch(/^#view=phone-hostile&in=/);
    // Nothing to wait on when the request never goes: as long as one takes here, several times over.
    await page.waitForTimeout(3_000);
    expect(leaks).toEqual([]);
    await page.locator('[data-screen="view"] [data-back]').click();
  }
  // The cookie jar it filled goes with every request the page makes to its server, which still
  // answers, the relay included: the page reloaded reaches the computer.
  expect(await page.evaluate(() => document.cookie.length)).toBeGreaterThan(400_000);
  await page.reload();
  await page.locator('[data-tab="views"]').click();
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  // The page's own key and pairing are as they were.
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId);
  expect(await page.evaluate(() => new Promise((done) => {
    const open = indexedDB.open("hive-web");
    open.onsuccess = () => { const get = open.result.transaction("kept").objectStore("kept").get("paired"); get.onsuccess = () => done(get.result?.with?.device); };
  }))).toBe(me.deviceId);
});
