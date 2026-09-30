// Who main answers (R7): the main frame of the app's own windows, and nothing else. A browser
// tile's registration names that tile's own page, so the debugger main drives for it can only
// ever be a browser page's, never an app window's.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-app-ipc-"));
const xdg = path.join(root, "config");
seedAgents(xdg);
// A terminal's session lives in the daemon here, so it has an id the test can name (hm:<tile>).
const env = { ...process.env, XDG_CONFIG_HOME: xdg, HIVEMIND_PTY_DAEMON: "1" } as Record<string, string>;
const userData = path.join(xdg, "hivemind-dev");
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
let hcp: Record<string, string> = {};
const hive = (...args: string[]) => {
  const result = spawnSync("bun", [cli, ...args, "--json"], { cwd: root, env: { ...env, ...hcp }, encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(result.stderr);
  return { status: result.status, data: JSON.parse(result.stdout) };
};
/** The browser tiles the discovery file tells agents about. */
const targets = (): string[] => {
  try { return JSON.parse(fs.readFileSync(path.join(userData, "browser-targets.json"), "utf8")).tiles.map((t: { tileId: string }) => t.tileId); } catch { return []; }
};

test.beforeAll(async () => {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow");
  await expect.poll(() => fs.existsSync(path.join(userData, "hcp.token"))).toBe(true);
  hcp = { HIVE_HCP_SOCK: path.join(userData, "hcp.sock"), HCP_TOKEN: fs.readFileSync(path.join(userData, "hcp.token"), "utf8").trim() };
});
test.afterAll(async () => {
  // This profile's daemon only, before the app closes (close waits on it), and again after it
  // (closing, the app starts one to let go of its tiles).
  const reap = () => { try { execSync(`pkill -f "out/main/pty-daemon.js ${xdg}/"`, { stdio: "ignore" }); } catch { /* none */ } };
  reap();
  const closed = await Promise.race([app?.close().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!closed) { try { app?.process().kill("SIGKILL"); } catch { /* gone */ } }
  reap();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A window with the app's preload that is not one of the app's windows runs `script` in it. */
async function asStranger(script: string): Promise<unknown> {
  const preload = path.join(process.cwd(), "out/preload/index.mjs");
  return app.evaluate(async ({ BrowserWindow }, { preload, script }) => {
    const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: false, contextIsolation: true } });
    try {
      await w.loadURL("data:text/html,<p>not an app window</p>");
      const result = await w.webContents.executeJavaScript(script);
      await new Promise((r) => setTimeout(r, 300)); // a message it sent is on its way before the window goes
      return result;
    } finally {
      w.destroy();
    }
  }, { preload, script });
}

test("a window that is not one of the app's is answered by none of its channels; the app's own window is", async () => {
  const stranger = await asStranger(`(async () => ({
    version: await window.hive.getAppVersion().then(() => "answered", () => "refused"),
    settings: window.hive.settingsSync() === null ? "refused" : "answered",
  }))()`);
  expect(stranger).toEqual({ version: "refused", settings: "refused" });
  expect(await page.evaluate(() => window.hive.getAppVersion())).toBe(await app.evaluate(({ app }) => app.getVersion()));
  expect(await page.evaluate(() => window.hive.settingsSync())).not.toBeNull();
});

test("an app window cannot be registered as a browser tile's page, so the debugger never drives it; a tile's own page is, until the tile closes", async () => {
  const ownPage = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.id);
  await page.evaluate((id) => window.hive.browserRegister("tile-browser-posing", id, null, ""), ownPage);
  await expect(page.evaluate(() => window.hive.browserCdp("tile-browser-posing", "Runtime.evaluate", { expression: "document.title", returnByValue: true })))
    .rejects.toThrow(/no browser tile registered for tile-browser-posing/);

  expect(hive("config", "set", "tools.enabledPlugins", '["hivemind/web"]').status).toBe(0);
  const opened = hive("ctl", "open-tool", "hivemind/web/browser", "--url", "about:blank");
  expect(opened.status).toBe(0);
  const tile: string = opened.data.tileId;
  await expect.poll(targets, { timeout: 15_000 }).toContain(tile);
  expect(targets()).not.toContain("tile-browser-posing");
  expect(await page.evaluate((t) => window.hive.browserCdp(t, "Runtime.evaluate", { expression: "location.href", returnByValue: true }), tile))
    .toMatchObject({ result: { value: "about:blank" } });

  expect(hive("ctl", "close", tile).status).toBe(0);
  await expect.poll(targets, { timeout: 10_000 }).not.toContain(tile);
});

test("a window that is not one of the app's cannot type into a terminal; the app's own window can", async () => {
  await page.mouse.move(900, 600);
  await page.keyboard.press("1");
  const tile = await page.locator(".react-flow__node-terminal").first().getAttribute("data-id");
  const pty = `hm:${tile}`;
  const marker = (name: string) => path.join(root, name);
  const type = (command: string) => page.evaluate(({ pty, command }) => window.hive.ptyWrite(pty, `${command}\r`), { pty, command });
  // The shell is up once a command typed from the window runs.
  await expect.poll(async () => { await type(`touch ${marker("ready")}`); return fs.existsSync(marker("ready")); }, { timeout: 20_000 }).toBe(true);
  await asStranger(`window.hive.ptyWrite(${JSON.stringify(pty)}, ${JSON.stringify(`touch ${marker("stranger")}\r`)})`);
  // Typed after it: once this has run, a command the stranger typed would have run first.
  await type(`touch ${marker("after")}`);
  await expect.poll(() => fs.existsSync(marker("after")), { timeout: 10_000 }).toBe(true);
  expect(fs.existsSync(marker("stranger"))).toBe(false);
});
