// A window that loses its GPU or renderer process (a laptop resumed from suspend) must come back on
// its own instead of sitting on a blank window. The reload is safe: terminals live in the daemon.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let app: ElectronApplication;
let page: Page;
let dir = "";

test.beforeAll(async () => {
  dir = fs.mkdtempSync("/tmp/hm-rec-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_PTY_DAEMON: "0" },
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});
test.afterAll(async () => {
  try { await Promise.race([app?.close(), new Promise((r) => setTimeout(r, 8_000))]); } catch { /* gone */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const pidOf = (type: string) => app.evaluate(({ app: a }, t) => a.getAppMetrics().find((m) => m.type === t)?.pid ?? null, type);

test("the GPU process dies: the window reloads and draws again", async () => {
  const gpu = await pidOf("GPU");
  test.skip(gpu === null, "no separate GPU process in this environment");
  await page.evaluate(() => { (window as unknown as { __beforeLoss?: boolean }).__beforeLoss = true; });
  process.kill(gpu!, "SIGKILL");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __beforeLoss?: boolean }).__beforeLoss ?? false).catch(() => true), { timeout: 20_000 }).toBe(false);
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
});

test("the renderer dies: the window reloads", async () => {
  await page.waitForTimeout(1_000);
  const wc = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId());
  process.kill(wc, "SIGKILL");
  // A script sent mid-reload can wait forever, so each check gives up quickly and the poll asks again.
  const canvasBack = () => app.evaluate(({ BrowserWindow }) => Promise.race([
    BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript("!!document.querySelector('.react-flow')").catch(() => false),
    new Promise((r) => setTimeout(() => r(false), 1500)),
  ]));
  await expect.poll(canvasBack, { timeout: 20_000 }).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId())).not.toBe(wc);
});
