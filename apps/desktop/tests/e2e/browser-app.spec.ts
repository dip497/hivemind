// Settings → Advanced → In a browser: the app serves itself to a browser tab on 127.0.0.1, and
// the tab is the app — its canvas, a shell typed into and its echo, a board's note and a plugin's
// widget pressed, a view plugin shown, a package's live wallpaper drawn — over the link the page shows. Without that link's key the
// port gives nothing, and a view in the tab reaches neither the tab's cookie nor its socket.
import { test, expect, chromium, type Browser, type Frame, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { freePort, launchWindow, type AppWindow } from "./helpers/window";
import { addFromMenu } from "./helpers/board";
import { installPlugin } from "./helpers/install";

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
  const counter = path.join(root, "src", "counter");
  fs.mkdirSync(counter, { recursive: true });
  fs.writeFileSync(path.join(counter, "widget.json"), JSON.stringify({ name: "Counter" }));
  fs.writeFileSync(path.join(counter, "widget.js"), COUNTER);
  installPlugin(xdg, counter);
  installPlugin(xdg, path.join(process.cwd(), "tests/e2e/fixtures/views/widget-viewer"));
  installPlugin(xdg, path.join(process.cwd(), "tests/e2e/fixtures/wallpapers/pond"));
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
  await desktop.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "browser" } })));
  const section = desktop.locator("[data-browser-app]");
  await section.locator("[data-browser-app-more] > summary").click();
  await section.locator("#browser-app-port").fill(String(port));
  await section.locator("#browser-app-port").press("Enter");
  await expect.poll(() => desktop.evaluate(() => window.hive.settingsSync().browserApp.port)).toBe(port);
  await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();

  await section.getByRole("switch", { name: "Serve the app to a browser" }).click();
  const shown = section.locator("[data-browser-app-url]");
  await expect(shown).toHaveText(`http://127.0.0.1:${port}/#token=…`);
  link = (await section.locator("[data-browser-app-open]").first().getAttribute("href"))!;
  expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#token=[A-Za-z0-9_-]{43}$`));
  // Another name, as tailscale serve gives it, has its link too: the same key, over HTTPS.
  await section.locator("#browser-app-names").fill("lap.tail1234.ts.net:8444");
  await section.locator("#browser-app-names").press("Enter");
  await expect.poll(() => desktop.evaluate(() => window.hive.settingsSync().browserApp.names)).toEqual(["lap.tail1234.ts.net:8444"]);
  await expect.poll(() => desktop.evaluate(async () => (await window.hive.browserAppStatus()).others)).toHaveLength(1);
  await expect(shown).toHaveText([`http://127.0.0.1:${port}/#token=…`, "https://lap.tail1234.ts.net:8444/#token=…"]);
  const there = (await section.locator("[data-browser-app-open]").nth(1).getAttribute("href"))!;
  expect(there).toBe(link.replace(`http://127.0.0.1:${port}`, "https://lap.tail1234.ts.net:8444"));
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

test("a tab open while the app is rebuilt reloads into the new build when it opens a dialog, rather than going blank", async () => {
  const assets = path.join(process.cwd(), "out/renderer/assets");
  const chunk = path.join(assets, fs.readdirSync(assets).find((f) => /^MachinesHub-.*\.js$/.test(f))!);
  await tab.evaluate(() => { (window as unknown as { beforeRebuild?: boolean }).beforeRebuild = true; });
  // The rebuild took away the old build's files the tab loads a dialog from on first use.
  fs.renameSync(chunk, `${chunk}.old`);
  try {
    // The page may already be reloading as the call returns.
    await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:machines", { detail: { kind: "manage" } }))).catch(() => undefined);
    await expect.poll(() => tab.evaluate(() => (window as unknown as { beforeRebuild?: boolean }).beforeRebuild ?? false).catch(() => true), { timeout: 15_000 }).toBe(false);
  } finally {
    fs.renameSync(`${chunk}.old`, chunk);
  }
  await tab.waitForSelector(".react-flow", { timeout: 30_000 });
  await tab.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:machines", { detail: { kind: "manage" } })));
  await expect(tab.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
  await tab.keyboard.press("Escape");
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

test("a package's live wallpaper draws in the tab, from its own path, and reaches neither the tab's cookie nor its socket", async () => {
  await tab.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/pond/dots"));
  await expect(tab.locator('.hm-live-frame[data-drawn][data-wallpaper="@e2e/pond/dots"]')).toBeVisible({ timeout: 15_000 });
  const frame = tab.frame({ name: "hm-wallpaper:@e2e/pond/dots" })!;
  expect(new URL(frame.url()).pathname).toMatch(/^\/hm-view\/[\w-]{43}\/wp-[0-9a-f]{32}\//);
  expect(await frame.evaluate(() => { try { return `read: ${document.cookie}`; } catch (e) { return (e as Error).name; } })).toBe("SecurityError");
  expect(await frame.evaluate(() => fetch("/").then((r) => `fetched ${r.status}`, () => "blocked"))).toBe("blocked");
  await tab.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "mono"));
});

test("a browser tile's page in the tab is the app window's own: it shows there, and a click and typing in the tab reach it", async () => {
  // A page of its own, on this machine: a button over the top half, a box to type in below.
  const site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Counter page</title><body style="margin:0">
      <button id=b style="display:block;width:100vw;height:50vh;font:40px sans-serif" onclick="this.textContent='clicked '+(++window.n)">press</button>
      <input id=t style="display:block;width:100vw;height:50vh;font:40px sans-serif"><script>window.n=0</script>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  try {
    await app.page.evaluate(() => window.hive.settingsSet("plugins.state.tool:@hivemind/web", { enabled: true }));
    await tab.locator('[data-toolbar-action="board"]').first().click();
    await tab.locator('[data-board-choice="tile:browser"]').click();
    const watched = tab.locator("[data-watched-page]");
    await expect(watched).toHaveCount(1, { timeout: 15_000 });
    const tileId = await tab.locator(".react-flow__node-browser").first().getAttribute("data-id");
    // The window holds the page; the tab sends it somewhere from its own address bar.
    const inWindow = (expression: string) => app.page.evaluate(([t, x]) => window.hive.browserCdp!(t, "Runtime.evaluate", { expression: x, returnByValue: true })
      .then((r) => (r as { result: { value: unknown } }).result.value, () => null), [tileId!, expression] as const);
    const address = watched.locator("[data-watched-page-address]");
    // Sent again until the window has the page: the tab's first send can come before its watch.
    await expect.poll(async () => {
      const title = await inWindow("document.title");
      if (title === "Counter page") return title;
      await address.fill(pageUrl);
      await address.press("Enter");
      return title;
    }, { timeout: 20_000, intervals: [2000] }).toBe("Counter page");

    // Its picture comes, and is the page: the tab draws what the window shows.
    const picture = watched.locator("[data-watched-page-picture] img");
    await expect(picture).toBeVisible({ timeout: 10_000 });
    await expect(address).toHaveValue(pageUrl);
    const before = await picture.getAttribute("src");

    const box = (await picture.boundingBox())!;
    await tab.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await expect.poll(() => inWindow("window.n"), { timeout: 10_000 }).toBe(1);
    // The page changed, so a new picture came.
    await expect.poll(() => picture.getAttribute("src"), { timeout: 10_000 }).not.toBe(before);

    await tab.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await expect.poll(() => inWindow("document.activeElement.id"), { timeout: 10_000 }).toBe("t");
    const frames = await tab.locator(".react-flow__node-frame").count();
    await tab.keyboard.type("typed in the tab");
    await expect.poll(() => inWindow("document.getElementById('t').value"), { timeout: 10_000 }).toBe("typed in the tab");
    // Typing went to the page, not the canvas: no frame was added by a key.
    expect(await tab.locator(".react-flow__node-frame").count()).toBe(frames);
  } finally {
    site.close();
  }
});

test("a note on a browser tile's page, made in the tab as a phone would, is kept and pinned on the page", async () => {
  const site = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Note page</title><body style="margin:0"><button id=go style="display:block;width:100vw;height:60vh;font:40px sans-serif">Go</button>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  try {
    await tab.locator('[data-toolbar-action="board"]').first().click();
    await tab.locator('[data-board-choice="tile:browser"]').click();
    const watched = tab.locator("[data-watched-page]").last();
    const tileId = await tab.locator(".react-flow__node-browser").last().getAttribute("data-id");
    const inWindow = (expression: string) => app.page.evaluate(([t, x]) => window.hive.browserCdp!(t, "Runtime.evaluate", { expression: x, returnByValue: true })
      .then((r) => (r as { result: { value: unknown } }).result.value, () => null), [tileId!, expression] as const);
    const address = watched.locator("[data-watched-page-address]");
    await expect.poll(async () => {
      const title = await inWindow("document.title");
      if (title === "Note page") return title;
      await address.fill(pageUrl);
      await address.press("Enter");
      return title;
    }, { timeout: 20_000, intervals: [2000] }).toBe("Note page");
    await expect(watched.locator("[data-watched-page-picture] img")).toBeVisible({ timeout: 10_000 });

    // A widget on the board can lie over the toolbar here; what is under test is the note.
    await watched.locator("[aria-label='annotate']").dispatchEvent("click");
    const layer = watched.locator("[data-annotate-layer]");
    await expect(layer).toBeVisible();
    const box = (await layer.boundingBox())!;
    await tab.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    const note = watched.locator("[data-note-box]");
    await expect(note).toContainText('button "Go"');
    await note.locator("textarea").fill("make it green");
    await note.locator("textarea").press("Enter");
    // The window's page did not take the click as a press of its button.
    await expect.poll(() => app.page.evaluate((r) => window.hive.reviewList(r).then((all) => all.map((c) => c.body)), repo)).toEqual(["make it green"]);
    await expect.poll(() => inWindow(`[...(document.querySelector("hivemind-page-notes")?.shadowRoot?.children ?? [])].map((p) => p.textContent).join()`)).toBe("1");
  } finally {
    site.close();
  }
});

test("turned off, the port closes", async () => {
  await app.page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "browser" } })));
  await app.page.locator("[data-browser-app]").getByRole("switch", { name: "Serve the app to a browser" }).click();
  await expect.poll(() => fetch(`http://127.0.0.1:${port}/`).then(() => "open", () => "closed")).toBe("closed");
});
