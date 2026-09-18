// A community view with its own controls, inside the sandbox: the example Queue view. With the host
// toolbar off it docks a preserved terminal from the mouse and from the keyboard, its navigation
// moves the HOST's selection, and it stops drawing when nothing changes.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { QUEUE_DIR, dockViaQueue, expandOtherTiles, framesDrawn, queueFrame, queueReady, releaseViaQueue } from "./helpers/queue-view";

let app: ElectronApplication;
let page: Page;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-queue-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") } as Record<string, string>;
const appDir = process.cwd();
const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const dockedTerminals = () => page.locator("[data-community-slot] .xterm");
const terminalIds = () => page.locator(".react-flow__node-terminal").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")!));

test.beforeAll(async () => {
  execFileSync("bun", [path.resolve(appDir, "../cli/src/index.ts"), "views", "install", QUEUE_DIR, "--json"], { env });
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
  await page.evaluate(() => window.hive.settingsSet("views.chrome", { queue: { island: "off" } }));
  await toView("queue");
  await page.waitForSelector(queueReady);
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "settings", exact: true })).toBeVisible();

  // Mouse: the row.
  await dockViaQueue(page, tileId!);
  expect(await page.locator(".xterm").evaluate((element, old) => element === old, original)).toBe(true);
  await releaseViaQueue(page);
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  expect(await queueFrame(page).locator("body").evaluate(() => typeof (window as unknown as { hive?: unknown }).hive)).toBe("undefined");

  // Keyboard: focus the list and move onto the row; moving docks. Retried for the same reason as the click.
  const list = queueFrame(page).locator(".q-list");
  await expandOtherTiles(page);
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

test("moving through the queue changes the host's selection", async () => {
  await toView("canvas");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(2);
  const ids = await terminalIds();

  await toView("queue");
  await page.waitForSelector(queueReady);
  const list = queueFrame(page).locator(".q-list");
  await expect(queueFrame(page).locator(".q-row")).toHaveCount(2);
  // The selection the host holds after the view has moved: read from the canvas, where it shows.
  const selectedOnCanvas = async () => {
    await toView("canvas");
    await page.waitForSelector(".react-flow__node-terminal");
    const picked = await page.locator(".react-flow__node-terminal:has(.hm-node-selected)").getAttribute("data-id");
    await toView("queue");
    await page.waitForSelector(queueReady);
    return picked;
  };
  // Shells are listed under "Other tiles"; the keys move only through groups that are open.
  const pickedInView = () => queueFrame(page).locator('.q-row[aria-selected="true"]').getAttribute("data-id").catch(() => null);
  // A freshly mounted frame can drop its first keys, so press until the view's own cursor lands.
  const pressUntil = async (keys: string[], want: (id: string | null) => boolean) => {
    let n = 0;
    await expect.poll(async () => {
      await expandOtherTiles(page);
      await list.focus().catch(() => {});
      await list.press(keys[n++ % keys.length]!).catch(() => {});
      return want(await pickedInView());
    }, { timeout: 10_000 }).toBe(true);
  };
  await pressUntil(["j"], (id) => id === ids[0] || id === ids[1]);
  const first = await pickedInView();
  expect(await selectedOnCanvas()).toBe(first);
  await pressUntil(["j", "k"], (id) => !!id && id !== first);
  const second = await pickedInView();
  expect(ids).toContain(second);
  expect(await selectedOnCanvas()).toBe(second);
});

test("the view stops drawing when idle", async () => {
  await toView("queue");
  await page.waitForSelector(queueReady);
  await expect.poll(() => framesDrawn(page)).toBeGreaterThan(0);
  // Frame reports are throttled by the SDK and the quiet state settles in under two seconds;
  // let both finish before sampling a quiet interval. This checks render activity, not FPS.
  await page.waitForTimeout(2500);
  const before = await framesDrawn(page);
  await page.waitForTimeout(1500);
  expect(await framesDrawn(page)).toBe(before);
});
