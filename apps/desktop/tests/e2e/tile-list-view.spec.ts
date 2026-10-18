// A community view with its own controls, inside the sandbox: the tile-list fixture. With the host
// toolbar off it docks a preserved terminal from the mouse and from the keyboard, its navigation
// moves the HOST's selection, and it stops drawing when nothing changes.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TILE_LIST_DIR, dockFromList, framesDrawn, tileListFrame, tileListReady, releaseFromList } from "./helpers/tile-list-view";
import { seedAgents } from "./helpers/agents";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tile-list-"));
seedAgents(path.join(root, "config"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
const appDir = process.cwd();
const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const dockedTerminals = () => page.locator("[data-community-slot] .xterm");
const terminalIds = () => page.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")!));

test.beforeAll(async () => {
  execFileSync("bun", [path.resolve(appDir, "../cli/src/index.ts"), "views", "install", TILE_LIST_DIR, "--json"], { env });
  app = await electron.launch({ args: [path.join(appDir, "out/main/index.js"), "--no-sandbox"], cwd: root, env });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
  await page.waitForSelector(".react-flow");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".xterm");
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("with the host toolbar off, the view docks a preserved terminal by mouse and by keyboard inside the sandbox", async () => {
  const original = await page.locator(".xterm").elementHandle();
  const [tileId] = await terminalIds();
  await page.evaluate(() => window.hive.settingsSet("views.chrome", { "tile-list": { island: "off" } }));
  await toView("tile-list");
  await page.waitForSelector(tileListReady);
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "settings", exact: true })).toBeVisible();

  // Mouse: the row.
  await dockFromList(page, tileId!);
  expect(await page.locator(".xterm").evaluate((element, old) => element === old, original)).toBe(true);
  await releaseFromList(page);
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  expect(await tileListFrame(page).locator("body").evaluate(() => typeof (window as unknown as { hive?: unknown }).hive)).toBe("undefined");

  // Keyboard: focus the list and move onto the row; moving docks. Retried for the same reason as the click.
  const list = tileListFrame(page).locator(".list");
  for (let attempt = 0; attempt < 4 && (await dockedTerminals().count()) === 0; attempt++) {
    await list.focus().catch(() => {});
    await list.press("j").catch(() => {});
    await page.waitForTimeout(400);
  }
  await expect(dockedTerminals()).toHaveCount(1, { timeout: 10_000 });

  await toView("canvas");
  await expect(page.locator(".react-flow__node-terminal .xterm")).toHaveCount(1);
  expect(await page.locator(".xterm").evaluate((element, old) => element === old, original)).toBe(true);
  await original?.dispose();
});

test("moving through the list changes the host's selection", async () => {
  await toView("canvas");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(2);
  const ids = await terminalIds();

  await toView("tile-list");
  await page.waitForSelector(tileListReady);
  const list = tileListFrame(page).locator(".list");
  await expect(tileListFrame(page).locator(".row")).toHaveCount(2);
  // The selection the host holds after the view has moved: read from the canvas, where it shows.
  const selectedOnCanvas = async () => {
    await toView("canvas");
    await page.waitForSelector(".react-flow__node-terminal");
    const picked = await page.locator(".react-flow__node-terminal:has(.hm-node-selected)").getAttribute("data-id");
    await toView("tile-list");
    await page.waitForSelector(tileListReady);
    return picked;
  };
  const pickedInView = () => tileListFrame(page).locator('.row[aria-selected="true"]').getAttribute("data-id").catch(() => null);
  // A freshly mounted frame can drop its first keys, so press until the view's own cursor lands.
  const pressUntil = async (keys: string[], want: (id: string | null) => boolean) => {
    let n = 0;
    await expect.poll(async () => {
      await list.focus().catch(() => {});
      await list.press(keys[n++ % keys.length]!).catch(() => {});
      return want(await pickedInView());
    }, { timeout: 10_000 }).toBe(true);
  };
  // The view asks the host to select a row's tile, then to dock it, in that order: once the host
  // shows it docked, it holds the selection too.
  const docked = (id: string | null) => expect(page.locator(`[data-community-slot="${id}"]`)).toHaveCount(1);
  await pressUntil(["j"], (id) => id === ids[0] || id === ids[1]);
  const first = await pickedInView();
  await docked(first);
  expect(await selectedOnCanvas()).toBe(first);
  await pressUntil(["j", "k"], (id) => !!id && id !== first);
  const second = await pickedInView();
  expect(ids).toContain(second);
  await docked(second);
  expect(await selectedOnCanvas()).toBe(second);
});

test("the view stops drawing when idle", async () => {
  await toView("tile-list");
  await page.waitForSelector(tileListReady);
  await expect.poll(() => framesDrawn(page)).toBeGreaterThan(0);
  // The view may wake briefly (relative-time refresh, late settle frames), so a fixed
  // window races those. Require a fully quiet window instead: an idle view has one, and
  // a view whose render loop kept running could never produce one. Render activity, not FPS.
  await expect.poll(async () => {
    const quiet = await framesDrawn(page);
    await page.waitForTimeout(1500);
    return quiet === (await framesDrawn(page));
  }, { timeout: 30_000 }).toBe(true);
});
