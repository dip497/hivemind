// The Layers panel as a person arranges it: pin a tile from its menu, choose in the View menu what
// is listed and how it is grouped, fold a section, and find all of it as they left it after a
// restart. The View menu is theirs (settings); pins and folds are theirs for this workspace.
// Deleting a frame that holds tiles asks whether they go with it; the canvas's loose tiles close together.
// Its rail picks the pane: tiles (projects, then groups), recents, machines.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRESETS } from "@hivemind/core/settings-schema";
import { contrastRatio } from "@hivemind/core/css-color";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-layers-"));
const repo = path.join(root, "repo");
const env = { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
let app: ElectronApplication;
let page: Page;

async function launch(): Promise<void> {
  app = await electron.launch({ args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
}
test.beforeAll(async () => {
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await launch();
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(page.locator(".react-flow__node-terminal")).toHaveCount(3);
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const panel = () => page.locator('aside[aria-label="Layers"]');
const rows = () => panel().locator("[data-layer-tile]");
const choose = async (menu: string, choice: string) => {
  await panel().locator("[data-layers-view-menu]").click();
  await page.locator(`[data-layers-view="${menu}"]`).click();
  await page.locator(`[data-layers-choice="${menu}:${choice}"]`).click();
};

test("a tile pinned from its menu leads the panel, under Pinned, and is not listed twice", async () => {
  const second = rows().nth(1);
  const id = (await second.getAttribute("data-layer-tile"))!;
  await second.hover();
  await second.locator("[data-layer-tile-menu]").click();
  await expect(page.locator("[data-layers-tile-actions]")).toBeVisible();
  await page.keyboard.press("p");
  await expect(panel().locator(`[data-layers-pinned] [data-layer-tile="${id}"]`)).toBeVisible();
  await expect(panel().locator(`[data-layer-tile="${id}"]`)).toHaveCount(1);
});

test("held, Ctrl numbers the rows as the panel lists them, and Ctrl+number goes to that one", async () => {
  const pinned = panel().locator("[data-layers-pinned] [data-layer-tile]").first();
  const pinnedId = (await pinned.getAttribute("data-layer-tile"))!;
  await expect(panel().locator("[data-layer-jump]")).toHaveCount(0);
  await page.keyboard.down("Control");
  // The pinned tile is listed first, so it is 1, whatever order the tiles were opened in.
  await expect(pinned.locator('[data-layer-jump="1"]')).toBeVisible();
  await expect(panel().locator("[data-layer-jump]")).toHaveCount(3);
  await page.keyboard.up("Control");
  // Ctrl+1, as main hands it on: it takes the key before the page, which synthetic keys skip.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "tile:1" })));
  await expect(panel().locator("[data-layer-jump]")).toHaveCount(0);
  await expect(panel().locator(`[data-layer-tile="${pinnedId}"]`)).toHaveAttribute("data-active", "true");
});

test("the hover card says what a row is", async () => {
  const row = rows().first();
  await row.hover();
  await expect(page.locator("[data-layers-card]")).toContainText((await row.innerText()).split("\n")[0]!.trim());
  await page.mouse.move(900, 500);
  await expect(page.locator("[data-layers-card]")).toHaveCount(0);
});

test("the View menu groups by status or not at all; a filter that leaves nothing says so and resets", async () => {
  // What is chosen is checked, in every choice.
  await panel().locator("[data-layers-view-menu]").click();
  await page.locator('[data-layers-view="status"]').click();
  await expect(page.locator('[data-layers-choice="status:all"] [data-menu-checked] svg')).toBeVisible();
  await expect(page.locator('[data-layers-choice="status:working"] [data-menu-checked]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await choose("groupBy", "status");
  await expect(panel().locator('[data-layers-bucket="idle"]')).toBeVisible();
  await choose("groupBy", "none");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
  await choose("status", "exited");
  // The pinned tile stays, whatever the filter.
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
  await expect(panel().locator('[data-layers-bucket="all"]')).toHaveCount(0);
  await choose("status", "all");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
});

test("pins, the View menu and a folded section are as they were left after a restart", async () => {
  await panel().locator('[data-layers-pinned] button[aria-expanded]').click();
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(0);
  await page.waitForTimeout(600); // the personal layout's debounced save
  await app.close();
  await launch();
  await expect(panel().locator("[data-layers-pinned] button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
  await expect(panel().locator('[data-layers-bucket="all"] [data-layer-tile]')).toHaveCount(2);
  await panel().locator('[data-layers-pinned] button[aria-expanded]').click();
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
  // Reset to defaults: grouped by machine again, the pin kept (it is not a View choice).
  await panel().locator("[data-layers-view-menu]").click();
  await page.locator("[data-layers-reset]").click();
  await expect(panel().locator("[data-layers-bucket]")).toHaveCount(0);
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]")).toHaveCount(1);
});

test("the panel names what it does: search narrows the list, its rows start things, its heading says how it is grouped", async () => {
  await expect(panel().locator("[data-layers-view-menu]")).toHaveText(/By project/);
  // Search: one tile's name leaves that tile.
  const name = (await rows().last().innerText()).split("\n")[0]!.trim();
  await panel().locator("[data-layers-search-toggle]").click();
  await panel().locator("[data-layers-search]").fill(name);
  await expect(rows()).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(panel().locator("[data-layers-search]")).toHaveCount(0);
  await expect(rows()).toHaveCount(3);
  // Nothing waits on the person: the bell says so.
  await expect(panel().locator("[data-layers-bell]")).toHaveAttribute("aria-label", "Nothing needs you");
  // Rows that start things.
  await panel().locator('[data-layers-action="add"]').click();
  await expect(page.locator("[data-add-menu]")).toBeVisible();
  await page.keyboard.press("Escape");
  // The rail: Plugins at its foot opens them; a pane it picks stays picked.
  await panel().locator('[data-layers-rail="plugins"]').click();
  await expect(page.locator("[data-plugins-home]")).toBeVisible();
  await page.keyboard.press("Escape");
  await panel().locator('[data-layers-rail="machines"]').click();
  await expect(panel().locator('[data-layers-pane="machines"] [data-machine-group="local"]')).toContainText("This computer");
  await expect(panel().locator('[data-layers-rail="machines"]')).toHaveAttribute("aria-current", "page");
  await panel().locator('[data-layers-rail="tiles"]').click();
  await expect(rows()).toHaveCount(3);
});

test("frames are grouped by the folder they run in; with one folder, there is no heading to say which", async () => {
  const projects = panel().locator("[data-layers-project]");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  // The new frame has no folder of its own: it runs in the workspace's, with the first.
  await expect(projects).toHaveCount(1);
  await expect(projects.locator("[data-layers-frame]")).toHaveCount(2);
  await expect(projects.first().getByText("repo", { exact: true }).first()).toBeVisible();
  await expect(panel().locator("[data-layers-project] > div").filter({ hasText: /^repo$/ })).toHaveCount(0);
  // An empty frame goes without asking.
  const added = projects.locator("[data-layers-frame]").last();
  await added.hover();
  await added.locator("[data-layers-frame-menu]").click();
  await page.locator("[data-frame-menu-delete]").click();
  await expect(projects.locator("[data-layers-frame]")).toHaveCount(1);
});

test("two folders are set apart, and a frame that bears its folder's name is not named twice", async () => {
  const other = path.join(root, "other");
  fs.mkdirSync(other);
  await app.evaluate(({ dialog }, picked) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog; }, other);
  await panel().locator('[data-layers-action="project"]').click();
  const projects = panel().locator("[data-layers-project]");
  await expect(projects).toHaveCount(2);
  await expect(panel().locator('[data-layers-project="other"] [data-layers-frame]')).toContainText("other");
  await expect(panel().locator("[data-layers-project-name]")).toHaveCount(0);
  const added = panel().locator('[data-layers-project="other"] [data-layers-frame]');
  await added.hover();
  await added.locator("[data-layers-frame-menu]").click();
  await page.locator("[data-frame-menu-delete]").click();
  await expect(projects).toHaveCount(1);
});

test("snoozed, a tile leaves the list for Snoozed until its time; Wake now brings it back", async () => {
  const row = rows().last(); // in its frame: the pinned one is listed first
  const id = (await row.getAttribute("data-layer-tile"))!;
  await row.hover();
  await row.locator("[data-layer-tile-menu]").click();
  await page.locator("[data-layers-snooze]").click();
  await page.locator('[data-layers-snooze-choice="1 hour"]').click();
  const snoozed = panel().locator("[data-layers-snoozed]");
  await expect(snoozed.locator(`[data-layer-tile="${id}"] [data-layer-until]`)).toContainText("until");
  await expect(panel().locator(`[data-layer-tile="${id}"]`)).toHaveCount(1);
  await snoozed.locator(`[data-layer-tile="${id}"]`).click({ button: "right" });
  await page.locator("[data-layers-wake]").click();
  await expect(snoozed).toHaveCount(0);
  await expect(panel().locator(`[data-layer-tile="${id}"]`)).toHaveCount(1);
});

test("a tile that changes while you look elsewhere is unread until you look; you can mark it unread again", async () => {
  const listed = rows();
  const other = listed.last();
  // Its shell is told to end in a second; meanwhile you look at another tile.
  await other.click();
  await page.waitForTimeout(300);
  await page.keyboard.type("sleep 1; exit\n");
  await listed.first().click();
  await expect(other.locator("[data-layer-unread]")).toHaveCount(1, { timeout: 15_000 });
  await other.click();
  await expect(other.locator("[data-layer-unread]")).toHaveCount(0);
  await listed.first().click();
  await other.click({ button: "right" });
  await page.locator("[data-layers-unread]").click();
  await expect(other.locator("[data-layer-unread]")).toHaveCount(1);
});

test("deleting a frame asks what becomes of its tiles: kept, they are listed once under Canvas, which closes them all", async () => {
  const frames = () => panel().locator("[data-layers-frame]");
  const terminals = page.locator(".react-flow__node-terminal");
  // Its ⋮, shown on the row under the pointer: no right-click needed.
  const remove = async () => {
    await frames().first().hover();
    await frames().first().locator("[data-layers-frame-menu]").click();
    await page.locator("[data-frame-menu-delete]").click();
  };
  const dialog = page.locator("[data-delete-frame]");
  await remove();
  await expect(dialog).toContainText("3 tiles");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(frames()).toHaveCount(1);
  await expect(terminals).toHaveCount(3);

  await remove();
  await page.locator("[data-delete-frame-keep]").click();
  await expect(frames()).toHaveCount(0);
  await expect(terminals).toHaveCount(3);
  await expect(rows()).toHaveCount(3);

  // Close all closes what Canvas lists: the pinned one is listed under Pinned, and stays.
  await panel().locator("[data-layers-loose]").hover();
  await panel().locator("[data-layers-close-loose]").click();
  await page.locator("[data-layers-close-loose-confirm]").getByRole("button", { name: "Close 2" }).click();
  await expect(terminals).toHaveCount(1);

  // A frame closed with its tiles takes them with it. The new workspace frame takes in the
  // loose tile too, so it holds both.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await expect(frames()).toHaveCount(1);
  await remove();
  await expect(dialog).toContainText("2 tiles");
  await page.locator("[data-delete-frame-close]").click();
  await expect(frames()).toHaveCount(0);
  await expect(terminals).toHaveCount(0);
});

test("the panel closes from its own header, and opens again from where it was", async () => {
  await panel().locator("[data-layers-close]").click();
  await expect(panel()).toHaveCount(0);
  await page.getByRole("button", { name: "show layers" }).click();
  await expect(panel()).toBeVisible();
});

test("joining a shared workspace is in the panel's title menu, and opens on the join form", async () => {
  await panel().locator("[data-layers-title]").click();
  await page.locator("[data-layers-join]").click();
  await expect(page.locator("[data-join-dialog]")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("Join a shared workspace");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a tile that fails reads failed and not finished: an exit 3 while you look elsewhere, a session that cannot be opened", async () => {
  const ids = () => page.locator(".react-flow__node-terminal").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")!));
  /** Opens a tile and gives back its id. */
  const opened = async (open: () => Promise<void>) => {
    const had = await ids();
    await open();
    await expect.poll(async () => (await ids()).length).toBe(had.length + 1);
    return (await ids()).find((id) => !had.includes(id))!;
  };
  const shell = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  const row = (id: string) => panel().locator(`[data-layer-tile="${id}"]`);
  const header = (id: string) => page.locator(`.react-flow__node-terminal[data-id="${id}"] .hm-term-root`);
  const failing = await opened(shell);
  const other = await opened(shell);
  await row(failing).click();
  await page.waitForTimeout(300);
  await page.keyboard.type("sleep 1; exit 3\n");
  await row(other).click();
  await expect(row(failing).locator('[data-layer-status="failed"]')).toBeVisible({ timeout: 15_000 });
  await expect(header(failing).locator('[data-status-look="failed"]')).toHaveCount(1);
  await expect(row(failing).locator("[data-layer-unread]")).toHaveCount(0);
  // A session that has ended, opened again: there is no exit code to say it failed.
  const frameId = await page.locator(".react-flow__node-frame").first().getAttribute("data-id");
  const gone = await opened(() => page.evaluate((frameId) => window.dispatchEvent(new CustomEvent("hivemind:open-session", {
    detail: { frameId, session: { id: "no-such-session", state: "live", cmd: "bash", args: [], cwd: "/", viewers: 0, cols: 80, rows: 24, title: "gone" } },
  })), frameId));
  await expect(header(gone).locator('[data-status-look="failed"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(row(gone).locator('[data-layer-status="failed"]')).toBeVisible();

  // Selected, the failed row's chip still reads: its word at 4.5:1 on its own fill over the row
  // (tests/unit/status-ink.test.ts holds every preset; this is the real page in three).
  await row(failing).click();
  await page.mouse.move(900, 600); // off the row, whose chip hides under the pointer
  const chip = row(failing).locator('[data-layer-status="failed"]');
  for (const preset of ["signal", "nord", "clean-light"] as const) {
    const p = PRESETS[preset]!;
    for (const [k, v] of [["appearance.palette", p.palette], ["appearance.mode", p.mode], ["appearance.preset", preset]] as const) {
      await page.evaluate(([k, v]) => window.hive.settingsSet(k as string, v), [k, v] as const);
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.preset)).toBe(preset);
    await expect(row(failing)).toHaveAttribute("data-active", "true");
    await expect(chip).toBeVisible();
    // The row's colour transition has ended: its surface is opaque again.
    await expect.poll(() => row(failing).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/\/ [\d.]+\)|rgba/);
    const { word, fill, under, tint } = await chip.evaluate((el) => {
      // What the screen shows: the row's surface, the chip's tint over it, the word's colour.
      const c = document.createElement("canvas").getContext("2d")!;
      const at = (...layers: string[]) => {
        c.clearRect(0, 0, 1, 1);
        for (const l of layers) { c.fillStyle = l; c.fillRect(0, 0, 1, 1); }
        return `rgb(${[...c.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(" ")})`;
      };
      const under = getComputedStyle(el.closest("[data-layer-tile]")!).backgroundColor;
      return { word: at(getComputedStyle(el).color), fill: at(under, getComputedStyle(el).backgroundColor), under, tint: getComputedStyle(el).backgroundColor };
    });
    expect({ preset, ratio: contrastRatio(word, fill)! >= 4.5 }, `${preset}: ${word} on ${fill} (${tint} over ${under})`).toEqual({ preset, ratio: true });
    await page.screenshot({ path: test.info().outputPath(`selected-failed-${preset}.png`) });
  }
});

test("scrolling a long list keeps the pinned tiles and the list's heading with its View menu in sight", async () => {
  if (await panel().locator("[data-layers-pinned] [data-layer-tile]").count() === 0) {
    await rows().first().hover();
    await rows().first().locator("[data-layer-tile-menu]").click();
    await page.keyboard.press("p");
  }
  for (let i = 0; i < 12; i++) await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.unmaximize(); win.setContentSize(1280, 640); });
  const list = panel().locator('[data-layers-pane="tiles"]');
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await expect(panel().locator("[data-layers-pinned] [data-layer-tile]").first()).toBeInViewport();
  await expect(panel().locator("[data-layers-view-menu]")).toBeInViewport();
  await panel().locator("[data-layers-view-menu]").click();
  await expect(page.locator('[data-layers-view="groupBy"]')).toBeVisible();
  await page.keyboard.press("Escape");
});
