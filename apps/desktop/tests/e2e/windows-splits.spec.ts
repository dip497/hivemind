// The Windows view's panes, as an editor's: a tab split right or down into a pane of its own, two
// terminals side by side, the divider dragged and made equal again, one pane maximized, a pane
// closed into its neighbour, and the arrangement as it was left when the view comes back.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-splits-"));
const repo = path.join(root, "repo");
let app: ElectronApplication;
let page: Page;
const view = () => page.frameLocator('[data-community-view="windows"] iframe');
const panesOf = () => view().locator(".w-pane");
const slots = () => page.locator("[data-community-slot]");
const toView = async (mode: string) => {
  await page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
  if (mode === "windows") await page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');
  else await page.waitForSelector(".react-flow");
};
/** Each shown slot's box, left to right then top to bottom. */
const boxes = () => slots().evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-community-slot"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })
  .sort((a, b) => a.x - b.x || a.y - b.y));

test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 860 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(3);
  await toView("windows");
  await expect(view().locator('[role="tab"]')).toHaveCount(3);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("switching between a pane's tabs resizes neither terminal: the one switched away from waits at its size", async () => {
  const tabs = view().locator('[role="tab"]');
  const logs: string[] = [];
  // A program in each of two tabs writes down every size it is told.
  for (const i of [0, 1]) {
    const log = path.join(root, `winch-${i}`);
    logs.push(log);
    await tabs.nth(i).click();
    await page.locator(`[data-community-slot="${await tabs.nth(i).getAttribute("data-tile-id")}"] .xterm-screen`).click();
    // It makes its log once it listens.
    await page.keyboard.type(`node -e 'const fs=require("fs");process.stdout.on("resize",()=>fs.appendFileSync(${JSON.stringify(log)},"x"));fs.writeFileSync(${JSON.stringify(log)},"");setInterval(()=>{},1e6)'\n`);
  }
  const told = () => logs.map((l) => (fs.existsSync(l) ? fs.readFileSync(l, "utf8").length : 0));
  await expect.poll(() => logs.every((l) => fs.existsSync(l)), { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(800);
  const before = told();
  for (let k = 0; k < 4; k++) {
    await tabs.nth(k % 2).click();
    await expect(page.locator(`[data-community-slot="${await tabs.nth(k % 2).getAttribute("data-tile-id")}"]`)).toHaveCount(1);
  }
  await page.waitForTimeout(800);
  expect(told()).toEqual(before);
  // Both are listening. A window made smaller reaches the tab shown at once, and the other one only
  // when it is shown.
  await page.setViewportSize({ width: 1300, height: 800 });
  await expect.poll(() => told()[1]! > before[1]!).toBe(true);
  expect(told()[0]).toBe(before[0]);
  await tabs.nth(0).click();
  await expect.poll(() => told()[0]! > before[0]!).toBe(true);
  await page.setViewportSize({ width: 1400, height: 860 });
  for (const i of [0, 1]) { await tabs.nth(i).click(); await page.keyboard.press("Control+C"); }
});

test("a terminal shown in a tab, then back on the canvas and not selected there, is told its tile's size there again", async () => {
  const tabs = view().locator('[role="tab"]');
  const third = (await tabs.nth(2).getAttribute("data-tile-id"))!;
  const log = path.join(root, "size-third");
  const size = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");
  // A program in the third terminal writes down the size it is told.
  await tabs.nth(2).click();
  await page.locator(`[data-community-slot="${third}"] .xterm-screen`).click();
  await page.keyboard.type(`node -e 'const w=()=>require("fs").writeFileSync(${JSON.stringify(log)},process.stdout.columns+"x"+process.stdout.rows);w();process.stdout.on("resize",w);setInterval(()=>{},1e6)'\n`);
  await expect.poll(size).not.toBe("");
  const inPane = size();
  // Selected on the canvas, it takes its tile's size there.
  await toView("canvas");
  await expect.poll(size).not.toBe(inPane);
  const onCanvas = size();
  // Shown in its tab again, then put away for another tab.
  await toView("windows");
  await expect.poll(size).toBe(inPane);
  await tabs.nth(0).click();
  // Back on the canvas with the first selected, the third is told its tile's size again.
  await toView("canvas");
  await expect.poll(size).toBe(onCanvas);
  await toView("windows");
  await tabs.nth(2).click();
  await page.locator(`[data-community-slot="${third}"] .xterm-screen`).click();
  await page.keyboard.press("Control+C");
});

test("a tab split right takes a pane of its own: two terminals side by side, each the tab its pane shows", async () => {
  await expect(slots()).toHaveCount(1);
  const moved = await view().locator('[role="tab"][aria-selected="true"]').getAttribute("data-tile-id");
  await view().locator(".w-bar").hover();
  await view().locator('[data-pane-tool="Split right"]').click();
  await expect(panesOf()).toHaveCount(2);
  await expect(slots()).toHaveCount(2);
  const [left, right] = await boxes();
  expect(right!.x).toBeGreaterThan(left!.x + left!.w);
  expect(Math.abs(left!.y - right!.y)).toBeLessThan(2);
  expect(right!.id).toBe(moved);
  // The moved tab is in the new pane only.
  await expect(panesOf().nth(1).locator('[role="tab"]')).toHaveCount(1);
  await expect(panesOf().nth(0).locator('[role="tab"]')).toHaveCount(2);
});

test("the divider gives one pane more room as it is dragged, and a double-click makes them equal", async () => {
  const [left] = await boxes();
  const grip = view().locator('.w-divider[data-dir="row"]');
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  // Under the pointer, the grip has the terminals let the pointer through, so a drag across them reaches it.
  await expect(slots().first()).toHaveClass(/pointer-events-none/);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(g.x + g.width / 2 - i * 20, g.y + g.height / 2);
  await page.mouse.up();
  await expect.poll(async () => (await boxes())[0]!.w).toBeLessThan(left!.w - 150);
  await grip.dblclick();
  await expect.poll(async () => { const [a, b] = await boxes(); return Math.abs(a!.w - b!.w); }).toBeLessThan(3);
});

test("split down from the pane's tools puts a third pane under the second", async () => {
  await panesOf().nth(0).locator(".w-bar").hover();
  await panesOf().nth(0).locator('[data-pane-tool="Split down"]').click();
  await expect(panesOf()).toHaveCount(3);
  await expect(slots()).toHaveCount(3);
  const [a, b, c] = await boxes();
  expect(a!.x).toBe(b!.x); // the first pane split into two, one above the other
  expect(b!.y).toBeGreaterThan(a!.y + a!.h);
  expect(c!.x).toBeGreaterThan(a!.x + a!.w);
  await page.screenshot({ path: "/tmp/hivemind-windows-splits.png" });
});

test("a maximized pane is shown alone, and restored among the others", async () => {
  const focused = panesOf().and(view().locator("[data-focused]"));
  await focused.locator('[data-pane-tool="Maximize"]').click();
  await expect(slots()).toHaveCount(1);
  await expect(panesOf()).toHaveCount(1);
  await view().locator('[data-pane-tool="Restore"]').click();
  await expect(slots()).toHaveCount(3);
});

test("the panes are as they were left when the view comes back", async () => {
  const before = await boxes();
  await toView("canvas");
  await toView("windows");
  await expect(slots()).toHaveCount(3);
  expect((await boxes()).map((b) => b.id)).toEqual(before.map((b) => b.id));
});

test("a closed pane gives its tabs to the one that takes its room; every tile is still a tab", async () => {
  const pane = panesOf().nth(2);
  await pane.locator(".w-bar").hover();
  await pane.locator('[data-pane-tool="Close pane"]').click();
  await expect(panesOf()).toHaveCount(2);
  await expect(view().locator('[role="tab"]')).toHaveCount(3);
});

test("the view's keys are the program's while a terminal has focus, and the view's once it has not", async () => {
  await expect(panesOf()).toHaveCount(2);
  // The closed pane's terminal leaves its slot a moment after the pane goes.
  await expect(slots()).toHaveCount(2);
  const id = (await slots().first().getAttribute("data-community-slot"))!;
  await page.locator(`[data-community-slot="${id}"] .xterm-screen`).click();
  // `cat -v` quits on Ctrl+\ (its terminal's quit key).
  await page.keyboard.type("cat -v\n");
  await page.waitForTimeout(300);
  // In the terminal the key is the program's, not the view's (9e2ee7f, #219): cat quit, no pane split.
  await page.keyboard.press("Control+Backslash");
  const screen = () => page.evaluate((tile) => ((document.querySelector(`[data-tile-slot="${tile}"] .xterm`)?.parentElement as unknown as { __hmScreen?: () => string } | undefined)?.__hmScreen?.() ?? ""), id);
  await expect.poll(screen).toMatch(/Quit/);
  await expect(panesOf()).toHaveCount(2);
  // Focus in the view (a click on its pane's bar, past the tabs): the key is the view's, and splits
  // the pane.
  const pane = view().locator(".w-pane", { has: view().locator(`[role="tab"][data-tile-id="${id}"]`) });
  const tabs = (await pane.locator(".w-tabs [role=tab]").last().boundingBox())!;
  const bar = (await pane.locator(".w-bar").boundingBox())!;
  await page.mouse.click(tabs.x + tabs.width + 12, bar.y + bar.height / 2);
  await page.keyboard.press("Control+Backslash");
  await expect(panesOf()).toHaveCount(3);
});

test("a tab dragged onto another pane's tabs joins them there; onto a pane's edge it splits that pane", async () => {
  // Panes by id: one left with no tab closes, and the others move up.
  const [source, target] = await panesOf().evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute("data-pane")!));
  const strip = (pane: string) => view().locator(`[data-pane="${pane}"] [role="tab"]`);
  const before = await strip(target!).count();
  const tab = strip(source!).first();
  const moved = await tab.getAttribute("data-tile-id");
  const from = (await tab.boundingBox())!;
  const to = (await strip(target!).first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
  // The terminals step aside while a tab is dragged, so where it would land shows.
  await expect(slots()).toHaveCount(0);
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
  await expect(view().locator('.w-drop[data-kind="tabs"]')).toBeVisible();
  await page.mouse.up();
  await expect(strip(target!)).toHaveCount(before + 1);
  await expect(strip(target!).first()).toHaveAttribute("data-tile-id", moved!);
  await expect(slots()).not.toHaveCount(0);

  const panesBefore = await panesOf().count();
  const drag = strip(target!).first();
  const d = (await drag.boundingBox())!;
  const stage = (await view().locator(`[data-pane="${target}"] .w-stage`).boundingBox())!;
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width - 8, stage.y + stage.height / 2, { steps: 10 });
  await expect(view().locator('.w-drop[data-kind="split"]')).toBeVisible();
  await page.mouse.up();
  await expect(panesOf()).toHaveCount(panesBefore + 1);
  await expect(view().locator('[role="tab"]')).toHaveCount(3);
});
