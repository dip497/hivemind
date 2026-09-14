import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-browser-plugin-"));
const xdg = path.join(root, "config");
const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: root, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};
const browsers = () => page.locator(".react-flow__node-browser");

test.beforeAll(async () => {
  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, "hivemind-view.json"), JSON.stringify({ id: "browser-request", name: "Browser request", version: "0.1.0", entry: "index.html", protocol: 1, permissions: ["workspace:spawn"] }));
  fs.writeFileSync(path.join(fixture, "index.html"), '<button id="open" disabled>Open Browser</button><script src="main.js"></script>');
  fs.writeFileSync(path.join(fixture, "main.js"), `window.addEventListener('message', e => {
    if (e.data?.type !== 'hivemind-view:port' || !e.ports[0]) return;
    const port = e.ports[0];
    port.onmessage = e => { if(e.data.type === 'hello') document.querySelector('button').disabled = false; };
    port.start(); port.postMessage({type:'ready',v:1});
    document.querySelector('button').onclick = () => port.postMessage({type:'command',name:'spawnTile',args:['browser',null]});
  });`);
  expect(hive("views", "install", fixture).status).toBe(0);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await page.waitForSelector(".react-flow");
  const userData = path.join(xdg, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("Browser opt-in is shared by Settings, shortcuts, CLI, and view commands; disabling preserves open work", async () => {
  await expect(page.getByTitle(/^Browser  /)).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((r) => /\/BrowserTile-/.test(r.name)))).toBe(false);
  expect(hive("ctl", "open-tool", "hivemind/web/browser", "--url", "about:blank").data.code).toBe("UNAUTHORIZED");
  await page.keyboard.press("7");
  await expect(page.getByText("Browser is disabled. Enable it in Settings under Tools.")).toBeVisible();
  await expect(browsers()).toHaveCount(0);

  await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="tools"]').click();
  await page.getByRole("switch", { name: "Enable Browser", exact: true }).click();
  await expect.poll(() => hive("config", "get", "tools.enabledPlugins").data.data).toEqual(["hivemind/web"]);
  await page.screenshot({ path: "/tmp/hivemind-browser-plugin-settings.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTitle(/^Browser  /)).toHaveCount(1);
  const opened = hive("ctl", "open-tool", "hivemind/web/browser", "--url", "about:blank");
  expect(opened.status).toBe(0);
  await expect(browsers()).toHaveCount(1);
  await page.waitForSelector("webview");
  const original = await page.locator("webview").elementHandle();
  expect(hive("config", "set", "tools.enabledPlugins", "[]").status).toBe(0);
  await expect(page.getByTitle(/^Browser  /)).toHaveCount(0);
  await expect(browsers()).toHaveCount(1);
  expect(await page.locator("webview").evaluate((element, old) => element === old, original)).toBe(true);
  expect(hive("ctl", "open-tool", "hivemind/web/browser").data.code).toBe("UNAUTHORIZED");
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  await page.evaluate((frameId) => window.dispatchEvent(new CustomEvent("hivemind:frame-open", { detail: { frameId, kind: "browser" } })), frameId);
  await expect(browsers()).toHaveCount(1);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "browser-request" } })));
  const host = page.locator('[data-community-view="browser-request"][data-community-ready="1"]');
  await expect(host).toBeVisible();
  const received = () => host.evaluate((el) => (el as unknown as { __community: { stats: { received: number } } }).__community.stats.received);
  const before = await received();
  const button = page.frameLocator('[data-community-view="browser-request"] iframe').getByRole("button", { name: "Open Browser" });
  await expect(button).toBeEnabled();
  await button.focus(); await page.keyboard.press("Enter");
  await expect.poll(received).toBeGreaterThan(before);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const listed = hive("ctl", "list").data;
  expect(listed.frames.flatMap((frame: { tiles: { kind: string }[] }) => frame.tiles).filter((tile: { kind: string }) => tile.kind === "browser")).toHaveLength(1);
  await original?.dispose();
});

test("a disabled Browser restores existing panels without enabling new ones", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(browsers()).toHaveCount(1);
  await expect.poll(() => page.evaluate((root) => {
    const saved = JSON.parse(localStorage.getItem(`hivemind:canvas-layout:${root}`) ?? "{}");
    return saved.tiles?.some((tile: { kind: string }) => tile.kind === "browser") ?? false;
  }, root)).toBe(true);
  await app.close();
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector("[data-active-view]");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await expect(browsers()).toHaveCount(1);
  await expect(page.getByTitle(/^Browser  /)).toHaveCount(0);
  expect(hive("ctl", "open-tool", "hivemind/web/browser").data.code).toBe("UNAUTHORIZED");
});
