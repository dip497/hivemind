// The Windows view, a view package that comes with the app: a tab strip in its sandboxed frame,
// the active tile's live body placed by the app, and the app's own Layers rail beside it. A
// spawned tile shows as a tab and its body renders; a minimized tab leaves the strip but stays
// in the rail, and selecting it there brings it back.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedAgents } from "./helpers/agents";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: ElectronApplication;
let page: Page;
const view = () => page.frameLocator('[data-community-view="windows"] iframe');
const tabsOf = () => view().locator('[role="tab"]');
const windowsReady = () => page.waitForSelector('[data-community-view="windows"][data-community-ready="1"]');

// Its own config and repository: what is installed or set on this machine is not the test's.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-windows-view-"));
const xdg = path.join(root, "config");
const repo = path.join(root, "repo");

test.beforeAll(async () => {
  seedAgents(xdg);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", `--user-data-dir=${path.join(root, "ud")}`],
    cwd: repo, env,
  });
  page = await app.firstWindow();
  page.on("console", (m) => console.log(`[r.${m.type()}]`, m.text()));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow");
  await page.waitForTimeout(300);
  // Spawn a shell tile so there's something to tab into.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })),
  );
  await page.waitForSelector(".react-flow__node-terminal");
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("toggle into windows mode shows a tab strip + active tile body", async () => {
  // Enter windows mode via the same event ⌘E dispatches.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
  // The react-flow canvas is gone; the view's tab strip appears.
  await windowsReady();
  expect(await page.locator(".react-flow").count()).toBe(0);
  // Exactly one tab (the shell), and it's selected + its terminal body mounts.
  const tabs = tabsOf();
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  // It wears the mark the app draws for a shell, not a stand-in character.
  await expect(tabs.first().locator(".w-mark svg")).toHaveCount(1);
  // The terminal body renders inside the active-body host (xterm mounts a canvas).
  await page.waitForSelector(".xterm");
  // The tab names it: the body comes without its own name bar, and the terminal takes the room.
  const slot = page.locator("[data-community-slot]").first();
  await expect(slot.locator("[data-tile-titlebar]")).toBeHidden();
  await expect.poll(() => slot.evaluate((el) => el.querySelector(".xterm-screen")!.getBoundingClientRect().top - el.getBoundingClientRect().top)).toBeLessThan(16);
  // No toolbar floats over it: the terminal runs to the window's foot.
  await expect(page.locator("[data-host-island], [data-host-island-handle]")).toHaveCount(0);
  expect(await slot.evaluate((el) => window.innerHeight - el.getBoundingClientRect().bottom)).toBeLessThan(24);
  await page.screenshot({ path: "/tmp/hivemind-windows-view.png" });
});

test("minimize hides the tab but keeps it in the graph rail; restore brings it back", async () => {
  const tab = tabsOf().first();
  await tab.hover();
  await tab.getByRole("button", { name: /^Minimize/ }).click();
  // Tab strip is now empty.
  await expect(tabsOf()).toHaveCount(0);
  // But the tile is still listed in the Layers rail (aside[aria-label="Layers"]).
  const rail = page.locator('aside[aria-label="Layers"]');
  await expect(rail).toBeVisible();
  const railRow = rail.locator('[role="button"]', { hasText: /shell/i }).first();
  await railRow.click();
  // Restored → back as a tab, selected again.
  await expect(tabsOf()).toHaveCount(1);
  await expect(tabsOf().first()).toHaveAttribute("aria-selected", "true");
});

test("with no toolbar, the panel's title menu switches back to the canvas", async () => {
  await page.locator("[data-layers-title]").click();
  await expect(page.locator('[data-layers-show-as="windows"]')).toHaveAttribute("data-state", "checked");
  await page.locator('[data-layers-show-as="canvas"]').click();
  await page.waitForSelector(".react-flow");
  expect(await page.locator('[data-community-view="windows"]').count()).toBe(0);
});

test("right-click a frame in the rail opens the actions menu and spawns into it", async () => {
  // Create a frame (the add-frame event) so the rail has a group.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame");
  await page.waitForTimeout(300);
  const rail = page.locator('aside[aria-label="Layers"]');
  await expect(rail).toBeVisible();
  // The frame group header's title button (title="Focus …"). Right-click it;
  // the contextmenu bubbles to the row div that carries onContextMenu.
  const titleBtn = rail.locator('button[title^="Focus"]').first();
  await expect(titleBtn).toBeVisible();
  await titleBtn.click({ button: "right" });
  // Menu appears. A nested submenu keeps its parent open: hovering an agent with launch
  // choices must not close "New agent" under the pointer.
  const menu = page.getByRole("menu").first();
  await expect(menu.getByRole("menuitem", { name: "New agent" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "New agent" }).hover();
  const nested = page.getByRole("menu").nth(1).locator('[role="menuitem"][aria-haspopup="menu"]').first();
  if (await nested.count()) {
    await nested.hover();
    await expect(page.getByRole("menuitem", { name: "As set in Settings", exact: true })).toBeVisible();
    await expect(nested).toBeVisible();
  }
  // Add a tool or widget: the Add menu, every tool in it, adding into this frame.
  const header = titleBtn.locator("xpath=ancestor::*[@data-layers-frame][1]");
  const inFrame = async () => Number((await header.innerText()).match(/(\d+)\s*$/)?.[1] ?? 0);
  const before = await inFrame();
  await menu.getByRole("menuitem", { name: "Add a tool or widget…" }).click();
  await expect(page.locator("[data-add-menu]")).toBeVisible();
  const beforeTerms = await page.locator(".react-flow__node-terminal").count();
  await page.locator('[data-add-menu] [data-board-choice="tile:shell"]').click();
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(beforeTerms + 1);
  // It landed in that frame: one more there.
  await expect.poll(inFrame).toBe(before + 1);
});

test("rename a frame inline from the rail context menu", async () => {
  const rail = page.locator('aside[aria-label="Layers"]');
  const titleBtn = rail.locator('button[title^="Focus"]').first();
  await titleBtn.click({ button: "right" });
  // Click the Rename item in the just-opened menu (last portal if any stacked).
  await page.getByRole("menuitem", { name: "Rename" }).click();
  // An input appears in the row; type a new name + Enter.
  const input = rail.getByRole("textbox", { name: "Rename frame" }).first();
  await expect(input).toBeVisible();
  await input.fill("Renamed Frame");
  await input.press("Enter");
  // The row now shows the new title.
  await expect(rail.locator('button[title^="Focus"]').filter({ hasText: "Renamed Frame" }).first()).toBeVisible();
});

test("Git submenu in the rail menu opens the commit modal", async () => {
  const rail = page.locator('aside[aria-label="Layers"]');
  await rail.locator('button[title^="Focus"]').first().click({ button: "right" });
  // The menu has a "Git" submenu row.
  const gitRow = page.getByRole("menu").getByRole("menuitem", { name: "Git" });
  await expect(gitRow.first()).toBeVisible();
  await gitRow.first().click();
  const commit = page.getByRole("menuitem", { name: "Commit…" });
  await expect(commit.first()).toBeVisible();
  // Push + Pull live in the same submenu.
  await expect(page.getByRole("menuitem", { name: "Push", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Pull", exact: true })).toBeVisible();
  await commit.first().click();
  await expect(page.getByRole("textbox", { name: "Commit summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Commit & Push/ })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a frame's ⋯ on the canvas opens the menu the rail opens, Git included", async () => {
  const names = async () => page.getByRole("menu").first().getByRole("menuitem").allInnerTexts();
  const rail = page.locator('aside[aria-label="Layers"]');
  await rail.locator('button[title^="Focus"]').first().click({ button: "right" });
  const fromRail = await names();
  await page.keyboard.press("Escape");
  const button = page.locator(".react-flow__node-frame").first().locator("[data-frame-actions]");
  await button.click();
  expect(await names()).toEqual(fromRail);
  // And it opens at its button, wherever the canvas is panned and zoomed.
  const b = (await button.boundingBox())!;
  const m = (await page.getByRole("menu").first().boundingBox())!;
  const gapX = Math.max(0, m.x - (b.x + b.width), b.x - (m.x + m.width));
  const gapY = Math.max(0, m.y - (b.y + b.height), b.y - (m.y + m.height));
  expect(Math.max(gapX, gapY)).toBeLessThan(12);
  expect(fromRail.join("|")).toContain("Git");
  await page.keyboard.press("Escape");
});

// Regression for the windowed-mode remote-agent-kill blocker: a view that unmounted the bodies of
// the tabs it did not show would detach their sessions, which for a remote (ssh://) tile kills its
// agent. The app keeps every open tile's body mounted whatever a view shows: one view places the
// active tile, and the rest wait, alive, at full size. These assert that contract observably.
test("every open tab's body stays mounted; switching tabs never remounts the inactive one", async () => {
  // Spawn a second terminal so there's definitely something to switch away
  // from and back to, regardless of what earlier tests in this file left open.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForTimeout(500);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
  await windowsReady();
  const tabs = tabsOf();
  await expect.poll(() => tabs.count()).toBeGreaterThanOrEqual(2);
  const tabCount = await tabs.count();

  // Every open tab's terminal is mounted AT ONCE, not just the active tab's.
  await expect(page.locator(".xterm")).toHaveCount(tabCount);

  // Tag the first tile's terminal. A remount produces a new node, which would not carry it.
  const idA = await tabs.nth(0).getAttribute("data-tile-id");
  expect(idA).toBeTruthy();
  await page.locator(".xterm").evaluateAll((els) => els.forEach((el, i) => { (el as unknown as Record<string, unknown>).__probe = `kept-${i}`; }));

  // Switch to the second tab, then back to the first.
  await tabs.nth(1).click();
  await page.waitForTimeout(300);
  await expect(page.locator(".xterm")).toHaveCount(tabCount); // still every body mounted
  await tabs.nth(0).click();
  await page.waitForTimeout(300);
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

  // Every terminal is the one tagged: none was unmounted and mounted again.
  const probes = await page.locator(".xterm").evaluateAll((els) => els.map((el) => (el as unknown as Record<string, unknown>).__probe));
  expect(probes.every((p) => typeof p === "string" && p.startsWith("kept-"))).toBe(true);
  expect(new Set(probes).size).toBe(tabCount);
});

test("no pty exit fires for a tile while switching tabs away from and back to it", async () => {
  // Own setup: this used to inherit windows mode from the test above, so a
  // failure there left it querying an empty canvas and reporting a cascade.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await windowsReady();
  await expect.poll(() => tabsOf().count()).toBeGreaterThanOrEqual(2);
  const ids = await tabsOf().evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-tile-id")).filter((id): id is string => !!id),
  );
  expect(ids.length).toBeGreaterThanOrEqual(2);

  // Wire a real onPtyExit listener (exposed on window.hive by the preload
  // bridge) for every open tile, then flip through all the tabs. If a tab
  // switch ever unmounts an inactive tile the way it used to, a persistent
  // local tile would at least detach cleanly — but a remote tile's detach is
  // routed to killRemotePty, which fires pty:exit. None should fire here.
  await page.evaluate((tileIds: string[]) => {
    (window as unknown as { __ptyExited: unknown[] }).__ptyExited = [];
    for (const id of tileIds) {
      window.hive.onPtyExit(id, (info) => {
        (window as unknown as { __ptyExited: unknown[] }).__ptyExited.push({ id, info });
      });
    }
  }, ids);

  const tabs = tabsOf();
  const count = await tabs.count();
  for (let i = 0; i < count; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(150);
  }
  await tabs.nth(0).click();
  await page.waitForTimeout(150);

  const exited = await page.evaluate(() => (window as unknown as { __ptyExited: unknown[] }).__ptyExited);
  expect(exited).toEqual([]);
});

// Regression: a rail restore used to be applied by an effect after the click's render, so a view
// switch landing before that render unmounted the view first, and the view saved the tab as
// still minimized. It came back minimized as soon as the selection moved on.
test("a restored tab stays restored when the view switches at once", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await windowsReady();
  const first = tabsOf().first();
  const id = await first.getAttribute("data-tile-id");
  const name = (await first.locator(".w-name").textContent())?.trim();
  expect(name).toBeTruthy();
  const tab = view().locator(`[role="tab"][data-tile-id=${JSON.stringify(id)}]`);
  await first.hover();
  await first.getByRole("button", { name: `Minimize ${name}` }).click();
  await expect(tab).toHaveCount(0);

  // Restore it from the rail, and switch view the moment the view shows it back: the view keeps
  // its layout at once, not after its usual wait, or the switch would take the restore with it.
  await page.locator('aside[aria-label="Layers"]').getByRole("button", { name: name!, exact: true }).click();
  await expect(tab).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await page.waitForSelector(".react-flow");

  // A new tile takes the selection, so only a restore that was kept puts the tab back.
  const terminals = page.locator(".react-flow__node-terminal");
  const before = await terminals.count();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(terminals).toHaveCount(before + 1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await windowsReady();
  await expect(tab).toHaveCount(1);
});

test("more tabs than the strip holds: they shrink to a readable name, the active one is in view, and the wheel reaches the rest", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await page.waitForSelector(".react-flow");
  const terminals = page.locator(".react-flow__node-terminal");
  const before = await terminals.count();
  for (let i = 0; i < 20; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(terminals).toHaveCount(before + 20, { timeout: 30_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await windowsReady();
  await expect.poll(() => tabsOf().count()).toBeGreaterThanOrEqual(before + 20);

  const strip = view().locator(".w-tabs");
  const geometry = () => strip.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const inView = (t: Element) => { const r = t.getBoundingClientRect(); return r.left >= box.left - 1 && r.right <= box.right + 1; };
    const all = [...el.querySelectorAll('[role="tab"]')];
    const active = all.findIndex((t) => t.getAttribute("aria-selected") === "true");
    // The tab farthest from the active one, at the other end of the strip.
    const far = active < all.length / 2 ? all.length - 1 : 0;
    // Names cut short, the selected tab's too ("shell #12" must read whole) while none is hovered.
    const cut = all.map((t) => t.querySelector(".w-name")!).filter((n) => n.scrollWidth > n.clientWidth + 1).length;
    return { overflow: el.scrollWidth > el.clientWidth, tabWidth: all[0]!.getBoundingClientRect().width, cut,
      activeInView: inView(all[active]!), far, farInView: inView(all[far]!) };
  });
  // The last spawned is selected, somewhere along a strip too long for the window: in view.
  await page.mouse.move(5, 600); // over no tab
  await expect.poll(async () => (await geometry()).activeInView).toBe(true);
  const at = await geometry();
  expect(at.overflow).toBe(true);
  // Shrunk, but every name still reads: about a dozen letters, the buttons out of its way.
  expect(at.tabWidth).toBeLessThan(220);
  expect(at.cut).toBe(0);
  expect(at.farInView).toBe(false);
  // A plain wheel over the strip scrolls it to the tab at the other end.
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, at.far === 0 ? -400 : 400);
  await expect.poll(async () => (await geometry()).farInView).toBe(true);
  // A tile spawned now lands at the end scrolled away from, selected: the strip brings it into view.
  const count = await tabsOf().count();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(tabsOf()).toHaveCount(count + 1);
  await expect.poll(async () => (await geometry()).farInView).toBe(false);
  await expect.poll(async () => (await geometry()).activeInView).toBe(true);
});

test("with no toolbar, the panel's Add a tool or widget still adds one, as a new tab", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
  await windowsReady();
  const before = await tabsOf().count();
  await page.locator('aside[aria-label="Layers"] [data-layers-action="add"]').click();
  await page.locator('[data-add-menu] [data-board-choice="tile:shell"]').click();
  await expect(page.locator("[data-add-menu]")).toHaveCount(0);
  await expect(tabsOf()).toHaveCount(before + 1);
});
