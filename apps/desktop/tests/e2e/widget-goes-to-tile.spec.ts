// A widget's button that goes to a tile (`hive.hm.commands.focusTile`, as Archipelago's Harbour and
// Ship's log do) shows it in the view on screen: a view package, which owns its camera, is asked to
// show it (its `reveal`), and the tile-list fixture docks it; `hive ctl focus` does the same. The
// docked terminal has the keyboard, and undocked with Shift+Esc the view has it back. A label
// longer than the card stays inside the card, cut short, and shows whole while the button has the
// keyboard.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPlugin } from "./helpers/install";
import { TILE_LIST_DIR, releaseFromList, tileListFrame, tileListReady } from "./helpers/tile-list-view";

const GO_TO = `
let tiles = [];
const draw = () => hive.render({ type: "stack", children: tiles.map((t) => ({
  type: "button", label: "Go to " + t.name + " · a label far longer than the card it sits in, as a task and its project are", action: { focus: t.id },
})) });
hive.on("start", () => { draw(); hive.hm.on("structure", (s) => { tiles = s.tiles; draw(); }); });
hive.on("action", (a) => { if (a && typeof a.focus === "string") hive.hm.commands.focusTile(a.focus); });
`;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-goes-to-repo-"));
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "hm-goes-to-ud-"));
const env = { ...process.env, XDG_CONFIG_HOME: path.join(ud, "config") } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
/** `hive …` as an agent runs it, reaching this app. */
const hive = (...args: string[]) => spawnSync("bun", [path.resolve(process.cwd(), "../cli/src/index.ts"), ...args, "--json"],
  { cwd: repo, env: { ...env, HIVEMIND_APP_DATA: ud }, encoding: "utf8" }).status;
let app: ElectronApplication;
let page: Page;
const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const card = () => page.locator('[data-widget-layer] [data-widget="go-to"]');

test.beforeAll(async () => {
  execSync("git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: repo });
  const dir = path.join(ud, "src", "go-to");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "widget.json"), JSON.stringify({ name: "Go to" }));
  fs.writeFileSync(path.join(dir, "widget.js"), GO_TO);
  installPlugin(path.join(ud, "config"), dir);
  installPlugin(path.join(ud, "config"), TILE_LIST_DIR);
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${ud}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await expect.poll(() => fs.existsSync(path.join(ud, "hcp.token"))).toBe(true);
});
test.afterAll(async () => {
  await app?.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(ud, { recursive: true, force: true });
});

test("a widget's button with a long label stays inside its card, and in a view package it shows the tile there with the keyboard in it, as `hive ctl focus` does", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(1, { timeout: 15_000 });
  const tileId = (await page.locator(".react-flow__node-terminal").getAttribute("data-id"))!;
  await page.locator('[data-toolbar-action="board"]').first().click();
  await page.locator('[data-board-choice="widget:go-to"]').click();
  const go = card().getByRole("button", { name: /^Go to / });
  await expect(go).toHaveCount(1, { timeout: 15_000 });

  // The label is cut short inside the card, not drawn past its edge.
  const [box, inner] = [await card().boundingBox(), await go.boundingBox()];
  expect(inner!.x + inner!.width).toBeLessThanOrEqual(box!.x + box!.width);
  expect(await go.locator("span").evaluate((s) => s.scrollWidth > s.clientWidth)).toBe(true);

  // In the tile-list view, the press asks the view to show the tile: it docks it and marks its row.
  await toView("tile-list");
  await page.waitForSelector(tileListReady);
  await expect(tileListFrame(page).locator(`.row[data-id="${tileId}"]`)).toHaveCount(1);
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);

  // Reached from the keyboard, the pointer elsewhere, the label shows whole, still inside the card.
  await page.mouse.move(700, 450);
  const focused = () => go.evaluate((el) => el === document.activeElement).catch(() => false);
  for (let i = 0; i < 80 && !(await focused()); i++) await page.keyboard.press("Tab");
  await expect(go).toBeFocused();
  expect(await go.locator("span").evaluate((s) => s.scrollWidth <= s.clientWidth)).toBe(true);
  const [wide, wrapped] = [await card().boundingBox(), await go.boundingBox()];
  expect(wrapped!.x + wrapped!.width).toBeLessThanOrEqual(wide!.x + wide!.width);

  // The press docks the tile with the keyboard in its terminal; Shift+Esc gives it to the view.
  const keysIn = () => page.evaluate((id) => (document.activeElement?.closest(`[data-community-slot="${id}"]`) ? "terminal" : document.activeElement?.tagName === "IFRAME" ? "view" : document.activeElement?.tagName ?? "none"), tileId);
  await go.click();
  await expect(page.locator(`[data-community-slot="${tileId}"] .xterm`)).toHaveCount(1, { timeout: 10_000 });
  await expect(tileListFrame(page).locator(`.row[data-id="${tileId}"]`)).toHaveAttribute("aria-selected", "true");
  await expect.poll(keysIn).toBe("terminal");
  await page.keyboard.press("Shift+Escape");
  await expect(page.locator("[data-community-slot]")).toHaveCount(0);
  await expect.poll(keysIn).toBe("view");

  // Asked for by an agent: shown again, with the keyboard.
  expect(hive("ctl", "focus", tileId)).toBe(0);
  await expect(page.locator(`[data-community-slot="${tileId}"] .xterm`)).toHaveCount(1, { timeout: 10_000 });
  await expect.poll(keysIn).toBe("terminal");
  await releaseFromList(page);
});
