// Settings → Your devices, "In a browser on this computer": the app serves itself to a browser tab on 127.0.0.1, and
// the tab is the app — its canvas, a shell typed into and its echo, a board's note and a plugin's
// widget pressed, a view plugin shown — over the link the page shows. Without that link's key the
// port gives nothing, and a view in the tab reaches neither the tab's cookie nor its socket.
import { test, expect, chromium, type Browser, type Frame, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort, launchWindow, type AppWindow } from "./helpers/window";
import { addFromMenu } from "./helpers/board";

// A widget a plugin draws: a count, and a button that adds to it in its code.
const COUNTER = `
const draw = () => hive.render({ type: "stack", children: [
  { type: "number", value: (hive.state && hive.state.n) || 0, label: "presses" },
  { type: "button", label: "Press", action: "inc" },
] });
hive.on("start", draw);
hive.on("action", (a) => { if (a === "inc") { hive.setState({ n: ((hive.state && hive.state.n) || 0) + 1 }); draw(); } });
`;

// One app and one tab, carried from test to test: a failure ends the run there.
test.describe.configure({ mode: "serial" });

let app: AppWindow;
let browser: Browser;
let tab: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-app-"));
const repo = path.join(root, "repo");
const xdg = path.join(root, "config");
let port = 0;
let link = "";

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  // Its own config: the widget and the view are this test's, and so is the setting it turns on.
  const counter = path.join(xdg, "hivemind", "widgets", "counter");
  fs.mkdirSync(counter, { recursive: true });
  fs.writeFileSync(path.join(counter, "widget.json"), JSON.stringify({ name: "Counter" }));
  fs.writeFileSync(path.join(counter, "widget.js"), COUNTER);
  fs.cpSync(path.join(process.cwd(), "tests/e2e/fixtures/views/widget-viewer"), path.join(xdg, "hivemind", "views", "widget-viewer"), { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: xdg };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchWindow({ cwd: repo, env, args: [`--user-data-dir=${path.join(root, "ud")}`] });
  await app.page.waitForSelector(".react-flow", { timeout: 30_000 });
  browser = await chromium.launch(process.env.HIVE_HARNESS_CHROMIUM ? { executablePath: process.env.HIVE_HARNESS_CHROMIUM } : {});
  port = await freePort();
});
test.afterAll(async () => {
  await browser?.close();
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const newTab = (): Promise<Page> => browser.newPage({ viewport: { width: 1600, height: 1000 } });
const counted = (page: Page) => page.evaluate((r) => window.hive.workspaceObjectsSync(r), repo)
  .then((objects) => (objects as Array<{ kind: string; widget?: string; state?: { n?: number } }>).find((o) => o.widget === "counter")?.state?.n);

test("off until the person turns it on, then the page shows its link with the key left out", async () => {
  const desktop = app.page;
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "your-devices" } })));
  const section = desktop.locator("[data-browser-app]");
  await section.locator("[data-browser-app-more] > summary").click();
  await section.locator("#browser-app-port").fill(String(port));
  await section.locator("#browser-app-port").press("Enter");
  await expect.poll(() => desktop.evaluate(() => window.hive.settingsSync().browserApp.port)).toBe(port);
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

  await section.getByRole("switch", { name: "Serve the app to a browser" }).click();
  const shown = section.locator("[data-browser-app-url]");
  await expect(shown).toHaveText(`http://127.0.0.1:${port}/#token=…`);
  link = (await section.locator("[data-browser-app-open]").getAttribute("href"))!;
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=[A-Za-z0-9_-]{43}$`));
  await desktop.keyboard.press("Escape");
});

test("without the link's key the port gives nothing: not the app's page, its code or its socket", async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  expect(page.status).toBe(401);
  expect(await page.text()).not.toContain("<script type=\"module\"");
  expect((await fetch(`http://127.0.0.1:${port}/browser.html`)).status).toBe(401);
  expect((await fetch(`http://127.0.0.1:${port}/hm-plugin/host/react.js`)).status).toBe(401);

  const stranger = await newTab();
  await stranger.goto(`http://127.0.0.1:${port}/#token=${"x".repeat(43)}`);
  await expect(stranger.getByText("This link is from before the app last started")).toBeVisible();
  await expect(stranger.locator(".react-flow")).toHaveCount(0);
  await stranger.close();
});

test("the link opens the app in the tab: its canvas, a shell typed into, and what the shell prints", async () => {
  tab = await newTab();
  await tab.goto(link);
  await tab.waitForSelector(".react-flow", { timeout: 30_000 });
  // The key leaves the address bar and the history as soon as the page has it.
  expect(tab.url()).toBe(`http://127.0.0.1:${port}/`);

  await tab.locator('[data-toolbar-action="board"]').click();
  await tab.locator('[data-board-choice="tile:shell"]').click();
  const term = tab.locator(".react-flow__node-terminal").first();
  await expect(term).toHaveCount(1);
  await term.locator(".xterm-screen").click();
  const marker = path.join(repo, "from-the-tab.txt");
  await expect.poll(async () => {
    await tab.keyboard.type(`echo from-the-tab-$((6*7)) > ${marker}\n`);
    return fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  }, { timeout: 20_000, intervals: [500] }).toBe("from-the-tab-42");
  await tab.keyboard.type("echo printed-$((20+22))\n");
  const screen = () => term.evaluate((el) => {
    const host = [el, ...el.querySelectorAll("*")].find((e) => "__hmScreen" in e) as (Element & { __hmScreen(): string }) | undefined;
    return host?.__hmScreen() ?? "";
  });
  await expect.poll(screen, { timeout: 10_000 }).toContain("printed-42");
});

test("a board's note and a plugin's widget draw in the tab, and a press there reaches the plugin's code", async () => {
  await addFromMenu(tab, "note", "written in the tab");
  const note = '.react-flow__node-widget:has([data-widget="note"])';
  await expect(tab.locator(note)).toContainText("written in the tab");
  // Through the app: its window, another client of the same workspace, shows it too.
  await expect(app.page.locator(note)).toContainText("written in the tab", { timeout: 10_000 });

  await tab.locator('[data-toolbar-action="board"]').first().click();
  await tab.locator('[data-board-choice="widget:counter"]').click();
  const widget = tab.locator('[data-widget-layer] [data-widget="counter"]');
  await expect(widget).toContainText("presses", { timeout: 15_000 });
  await widget.getByRole("button", { name: "Press" }).click();
  await widget.getByRole("button", { name: "Press" }).click();
  await expect(widget).toContainText("2");
  await expect.poll(() => counted(app.page), { timeout: 10_000 }).toBe(2);
});

test("a view plugin draws in the tab: the Windows view", async () => {
  await tab.locator("[data-view-switch]").click();
  await tab.locator('[data-view-choice="windows"]').click();
  await tab.waitForSelector('[data-community-view="windows"][data-community-ready="1"]', { timeout: 20_000 });
  await expect(tab.frameLocator('[data-community-view="windows"] iframe').locator(".w-room")).toHaveCount(1);
  // The Windows view has no toolbar, so no view switch: back the way its key would go.
  await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(tab.locator(".react-flow")).toHaveCount(1);
});

/** The widget viewer, shown in the tab, and its frame. */
async function widgetViewer(): Promise<Frame> {
  await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "widget-viewer" } })));
  const iframe = tab.locator('[data-community-view="widget-viewer"] iframe');
  await expect(iframe).toHaveCount(1, { timeout: 20_000 });
  return (await (await iframe.elementHandle())!.contentFrame())!;
}

test("a view in the tab shows the widgets, and a press in it reaches the plugin's code", async () => {
  await widgetViewer();
  const frame = tab.frameLocator('[data-community-view="widget-viewer"] iframe');
  const card = frame.locator('[data-widget="counter"]');
  await expect(card).toContainText("Counter", { timeout: 20_000 });
  const press = card.getByRole("button", { name: "Press" });
  await expect.poll(async () => { await press.hover(); return frame.locator("body").getAttribute("data-pointer"); }).toBe("1");
  await press.click();
  await expect.poll(() => counted(app.page), { timeout: 10_000 }).toBe(3);
});

test("a view in the tab reaches neither the tab's cookie nor its socket, and its address does not carry the link's key", async () => {
  const frame = await widgetViewer();
  const token = new URL(link).hash.slice("#token=".length);
  expect(new URL(frame.url()).pathname).toMatch(/^\/hm-view\/[\w-]{43}\/widget-viewer\//);
  expect(frame.url()).not.toContain(token);
  expect(await frame.evaluate(() => { try { return `read: ${document.cookie}`; } catch (e) { return (e as Error).name; } })).toBe("SecurityError");
  expect(await frame.evaluate((at) => new Promise<string>((done) => {
    const ws = new WebSocket(at);
    ws.onopen = () => done("open");
    ws.onerror = () => done("refused");
    setTimeout(() => done("no answer"), 5000);
  }), `ws://127.0.0.1:${port}/socket`)).not.toBe("open");
  expect(await frame.evaluate(() => fetch("/").then((r) => `fetched ${r.status}`, () => "blocked"))).toBe("blocked");
  await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
});

test("turned off, the port closes", async () => {
  await app.page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "your-devices" } })));
  await app.page.locator("[data-browser-app]").getByRole("switch", { name: "Serve the app to a browser" }).click();
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/`).then(() => "open", () => "closed")).toBe("closed");
});
