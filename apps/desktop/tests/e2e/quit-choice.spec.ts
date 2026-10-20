// Quitting as a person does (closing the last window, the Quit items) while a terminal runs asks
// whether it keeps running in the background process or stops; with nothing running it quits at
// once. Keys go through main's before-input-event, which Playwright's do not reach (shortcuts.test.ts).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonSessions, socketAt } from "@hivemind/agent-host/daemon-replace";
import { stopDaemons } from "./helpers/daemons";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let dir = "";
let app: ElectronApplication | null = null;
/** The last app launched has not exited. */
let open = false;

const sock = () => path.join(dir, "ud", "pty-daemon.sock");
const live = async () => (await daemonSessions(socketAt(sock()))).filter((s) => s.state === "live").map((s) => s.id);
const settings = () => JSON.parse(fs.readFileSync(path.join(dir, "xdg", "hivemind", "settings.json"), "utf8")) as { quit?: { whenRunning?: string } };

async function launch(): Promise<Page> {
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${dir}/ud`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: path.join(dir, "home"), XDG_CONFIG_HOME: path.join(dir, "xdg"), HIVEMIND_SHELL_ENV: "0" },
  });
  open = true;
  app.process().once("exit", () => { open = false; });
  const page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  return page;
}

async function withTerminal(page: Page): Promise<string> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect.poll(live, { timeout: 20_000 }).toHaveLength(1);
  return (await live())[0]!;
}

/** The app's process is gone. */
function exited(a: ElectronApplication): Promise<void> {
  const p = a.process();
  return p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", () => r()));
}

/** Close the last window, as its title bar's × does. */
const closeWindow = (a: ElectronApplication) => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());

test.beforeEach(() => {
  dir = fs.mkdtempSync("/tmp/hm-quit-");
  for (const d of ["home", "xdg"]) fs.mkdirSync(path.join(dir, d));
});
test.afterEach(async () => {
  if (app && open) await Promise.race([app.close(), new Promise((r) => setTimeout(r, 8_000))]).catch(() => {});
  app = null;
  stopDaemons(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("with nothing running, closing the window quits at once", async () => {
  await launch();
  const gone = exited(app!);
  await closeWindow(app!);
  await expect(Promise.race([gone.then(() => "quit"), new Promise((r) => setTimeout(() => r("still open"), 10_000))])).resolves.toBe("quit");
});

test("Keep them running quits, and the terminal goes on in the background process", async () => {
  const page = await launch();
  const id = await withTerminal(page);
  await closeWindow(app!);
  const ask = page.locator("[data-quit-ask]");
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("heading")).toHaveText("Quit Hivemind?");
  await expect(ask).toContainText("1 terminal is still running.");
  await expect(ask.locator("[data-quit-keep]")).toBeFocused();
  await page.screenshot({ path: test.info().outputPath("quit-dialog.png") });

  const gone = exited(app!);
  await ask.locator("[data-quit-keep]").click();
  await gone;
  expect(await live()).toEqual([id]);
});

test("Cancel keeps the app open", async () => {
  const page = await launch();
  await withTerminal(page);
  await closeWindow(app!);
  const ask = page.locator("[data-quit-ask]");
  await ask.locator("[data-quit-cancel]").click();
  await expect(ask).toBeHidden();
  expect(app!.process().exitCode).toBeNull();
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});

test("Stop everything ends the terminal, kept as asked, and the next start brings it back", async () => {
  test.setTimeout(120_000);
  let page = await launch();
  const id = await withTerminal(page);
  await page.evaluate(() => void window.hive.quit?.());
  const ask = page.locator("[data-quit-ask]");
  await ask.locator("[data-quit-remember]").check();
  const gone = exited(app!);
  await ask.locator("[data-quit-stop]").click();
  await gone;
  expect(await live()).toEqual([]);
  expect(fs.existsSync(sock())).toBe(false);
  expect(settings().quit?.whenRunning).toBe("stop-everything");

  page = await launch();
  await expect.poll(live, { timeout: 30_000 }).toEqual([id]);
  // Kept: the next quit stops everything without asking.
  const again = exited(app!);
  await closeWindow(app!);
  await again;
  expect(await live()).toEqual([]);
});

test("Quit and stop agents stops everything without asking", async () => {
  const page = await launch();
  await withTerminal(page);
  const gone = exited(app!);
  await page.evaluate(() => void window.hive.quitAndStopEverything?.());
  await gone;
  expect(await live()).toEqual([]);
});
