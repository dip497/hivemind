// A live wallpaper in the built app. A package's, installed while the app was closed, is offered
// once as the background and Use draws it, in its sandboxed frame, told its size, the theme and
// whether to run, and the pointer and clicks over empty canvas: nothing of the workspace, though
// agents are open. One that says what is no message is turned off for the session, the plain
// background showing instead; one that takes the keyboard is turned off, what had the keyboard
// getting it back; a package switched off stops its wallpaper in every window; and a view the
// repository ships named like a wallpaper's origin is never served there. Each of the app's own
// scenes moves while it runs and holds still with Animation off.
import { test, expect, _electron as electron, type ElectronApplication, type Frame, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-live-wallpaper-"));
const xdg = path.join(root, "config");
const repo = path.join(root, "repo");
const bin = path.join(root, "bin");
const env = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: xdg, HIVE_SETTINGS: path.join(xdg, "settings.json"), HIVEMIND_SHELL_ENV: "0", PATH: `${bin}:${process.env.PATH}` } as Record<string, string>;
delete env.ELECTRON_RUN_AS_NODE;
const cli = path.resolve(process.cwd(), "../cli/src/index.ts");
const fixture = (name: string) => path.resolve(process.cwd(), "tests/e2e/fixtures/wallpapers", name);
/** Set to a folder to keep a picture of each step. */
const shots = process.env.LIVE_WALLPAPER_SHOTS;

/** A stand-in agent that sits at its prompt: enough for a tile whose creature the wallpaper draws.
 *  Its hooks come as Claude Code's do, a --settings document. */
function standInAgent(): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "pond-agent"), [
    "#!/bin/bash",
    "settings=''",
    "while [ $# -gt 0 ]; do case \"$1\" in --settings) settings=\"$2\"; shift 2;; *) shift;; esac; done",
    "export SETTINGS=\"$settings\"",
    "node -e 'for (const g of JSON.parse(process.env.SETTINGS || \"{}\").hooks?.SessionStart ?? []) for (const h of g.hooks ?? []) console.log(h.command)' |",
    "  while IFS= read -r c; do printf '{\"session_id\":\"s1\",\"hook_event_name\":\"SessionStart\"}' | sh -c \"$c\" >/dev/null 2>&1; done",
    "printf 'pond> '",
    "while read -r line; do printf 'pond> '; done",
  ].join("\n"), { mode: 0o755 });
  const dir = path.join(xdg, "hivemind", "agents", "pond");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), [
    "manifestVersion: 2", "id: pond", "label: Pond", "bin: pond-agent", "enabled: true",
    "caps: { promptDelivery: typed, turnSignal: true, resume: none, supervise: human, blockedDetection: true }",
    "launch: { hcp: true }",
    "detect:", "  default: working", "  rules:",
    "  - when: { contains: 'pond>' }", "    then: idle",
    "hooks:", "  arg: --settings", "  template: '{\"hooks\":{events}}'", "  events:",
    "    SessionStart: { emit: session.started, timeout: 10 }",
    "",
  ].join("\n"));
}

/** A view the repository ships, named like the wallpaper's own origin: it must never be served there. */
function impostorView(wallpaper: string): void {
  const id = `wp-${createHash("sha256").update(wallpaper).digest("hex").slice(0, 32)}`;
  const dir = path.join(repo, ".hivemind", "views", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "hivemind-view.json"), JSON.stringify({ id, name: "Impostor", version: "0.0.1", entry: "index.html" }));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Impostor</title><p>impostor</p>");
}

const install = (dir: string) => {
  const r = spawnSync("bun", [cli, "plugins", "install", dir, "--json"], { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
};

let app: ElectronApplication;
let page: Page;
const shot = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
/** The wallpaper's frame, once its page has drawn (before, it may still be the empty page). */
const wallpaperFrame = async (id: string): Promise<Frame> => {
  await expect(page.locator(`.hm-live-frame[data-drawn][data-wallpaper="${id}"]`)).toHaveCount(1);
  return page.frame({ name: `hm-wallpaper:${id}` })!;
};
const tiles = () => page.locator(".react-flow__node-terminal").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-id")!));
/** A point of empty canvas, the pane itself, clear of every tile and panel by `margin`. */
const openWater = (margin: number) => page.evaluate((m) => {
  const free = (x: number, y: number) => document.elementFromPoint(x, y)?.classList.contains("react-flow__pane");
  for (let y = innerHeight - 140; y > 140; y -= 20) {
    for (let x = innerWidth - 120; x > 120; x -= 20) {
      if ([[0, 0], [-m, -m], [m, -m], [-m, m], [m, m]].every(([dx, dy]) => free(x + dx!, y + dy!))) return { x, y };
    }
  }
  return null;
}, margin);

/** Zoomed out, so there is water between the tiles. */
async function zoomOut(): Promise<void> {
  await page.locator('button[title="Fit to view (Esc)"]').click();
  await page.mouse.move(800, 450);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 120);
}

test.beforeAll(async () => {
  for (const d of [repo, path.join(root, "home")]) fs.mkdirSync(d, { recursive: true });
  execSync("git init -q && git commit -q --allow-empty -m init", { cwd: repo, env: { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  standInAgent();
  impostorView("@e2e/pond/dots");
  // Installed while the app is closed: it is offered when the app starts.
  install(fixture("pond"));
  install(fixture("rogue"));
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: repo, env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  await page.evaluate(() => window.hive.settingsSet("agents.defaultAgent", "pond"));
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:shortcut", { detail: "agent" })));
    await expect.poll(async () => (await tiles()).length, { timeout: 20_000 }).toBe(i + 1);
  }
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test("offered once as the background, Use draws it, told its size, the theme and the mode, and nothing of the workspace", async () => {
  const offer = page.locator('[data-start-view-offer="@e2e/pond"]');
  await expect(offer).toContainText("Pond is installed. Use Dots as your background?");
  await shot("1-offer");
  // The repository's views are listed before the wallpaper's frame loads, the impostor among them.
  const views = await page.evaluate((r) => window.hive.listViews(r), repo);
  expect(views.filter((v) => v.id.startsWith("wp-") && !v.error).map((v) => v.manifest?.name)).toEqual(["Impostor"]);
  await offer.locator('[data-use-start-wallpaper="@e2e/pond/dots"]').click();
  await expect(offer).toHaveCount(0);
  await expect(page.locator('.hm-live-frame[data-drawn][data-wallpaper="@e2e/pond/dots"]')).toBeVisible();
  expect(await page.evaluate(() => window.hive.settingsGet().then((s) => s.appearance.wallpaper.kind))).toBe("@e2e/pond/dots");
  const frame = await wallpaperFrame("@e2e/pond/dots");
  const told = await frame.evaluate(() => (window as unknown as { seen: { look: Record<string, unknown>; viewport: { w: number } } }).seen);
  expect(Object.keys(told.look).sort()).toEqual(["dark", "mono", "page", "text"]);
  expect(told.viewport.w).toBeGreaterThan(1000);
  await shot("2-drawn");
});

test("the pointer over empty canvas and a click there reach it, to play with; over a tile, the pointer is gone", async () => {
  const frame = await wallpaperFrame("@e2e/pond/dots");
  type Seen = { pointer: { x: number; y: number; over: boolean } | null; clicks: Array<{ x: number; y: number }> };
  const seen = () => frame.evaluate(() => (window as unknown as { seen: Seen }).seen);
  await zoomOut();
  await expect.poll(() => openWater(40)).not.toBeNull();
  const water = (await openWater(40))!;
  await page.mouse.move(water.x - 3, water.y);
  await page.mouse.move(water.x, water.y);
  await expect.poll(async () => (await seen()).pointer).toEqual({ x: water.x, y: water.y, over: true });
  await page.mouse.click(water.x, water.y);
  await expect.poll(async () => (await seen()).clicks).toContainEqual({ x: water.x, y: water.y });
  // A click on the water selects no tile and opens nothing.
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
  const [tile] = await tiles();
  const onTile = await middleOf(tile!);
  await page.mouse.move(onTile.x, onTile.y);
  await expect.poll(async () => (await seen()).pointer?.over).toBe(false);
});

test("a wallpaper that says what is no message is turned off, and the plain background shows", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/flood"));
  await expect(page.getByText(/The Flood live wallpaper was turned off: \d+ malformed messages \(last: unknown message type "spawn"\)/)).toBeVisible();
  await expect(page.locator('.hm-wallpaper[data-scene="mono"]')).toHaveCount(1);
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await shot("4-turned-off");
});

test("what the app sends a wallpaper, as sent, holds nothing of the workspace", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/liar"));
  const frame = await wallpaperFrame("@e2e/rogue/liar");
  const heard = () => frame.evaluate(() => (window as unknown as { heard: Array<Record<string, unknown>> }).heard);
  // The canvas moved and the pointer went over it: whatever the app would say, it has said.
  const water = (await openWater(40))!;
  await page.mouse.move(water.x, water.y);
  await page.mouse.click(water.x, water.y);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await heard()).some((m) => m.type === "click")).toBe(true);
  const all = await heard();
  expect([...new Set(all.map((m) => m.type))].every((t) => ["hello", "viewport", "look", "mode", "pointer", "click"].includes(t as string))).toBe(true);
  expect(Object.keys(all.find((m) => m.type === "hello")!).sort()).toEqual(["look", "mode", "protocol", "type", "viewport"]);
  const ids = await tiles();
  expect(ids.filter((id) => JSON.stringify(all).includes(id))).toEqual([]);
});

const middleOf = async (tile: string) => {
  const b = (await page.locator(`.react-flow__node[data-id="${tile}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test("a wallpaper that takes the keyboard is turned off, and what had the keyboard gets it back", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/liar"));
  const frame = await wallpaperFrame("@e2e/rogue/liar");
  // The keyboard on a row of the Tiles list: nothing but the guard would give it back there.
  const [tile] = await tiles();
  const focusedRow = () => page.evaluate(() => document.activeElement?.getAttribute("data-layer-tile") ?? null);
  await page.locator(`[data-layer-tile="${tile}"]`).focus();
  await expect.poll(focusedRow).toBe(tile);
  await frame.evaluate(() => (window as unknown as { steal: () => void }).steal());
  await expect(page.getByText(/The Liar live wallpaper was turned off: it took the keyboard/)).toBeVisible();
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await expect.poll(focusedRow).toBe(tile);
  await shot("4b-took-the-keyboard");
});

test("a package switched off stops its wallpaper in every window, not only the one that switched it", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/pond/dots"));
  await expect(page.locator('.hm-live-frame[data-drawn][data-wallpaper="@e2e/pond/dots"]')).toBeVisible();
  // As from another window: main switches it and tells every window; this one asks for nothing.
  await page.evaluate(() => window.hive.switchPackage("@e2e/pond", false));
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await expect(page.locator('.hm-wallpaper[data-scene="mono"]')).toHaveCount(1);
  await page.evaluate(() => window.hive.switchPackage("@e2e/pond", true));
});

test("each of the app's own scenes moves while it runs, and holds still with Animation off", async () => {
  await zoomOut();
  const water = (await openWater(110))!;
  expect(water, "some empty canvas to watch").not.toBeNull();
  const clip = { x: water.x - 100, y: water.y - 100, width: 200, height: 200 };
  // The window keeps the focus it has: a scene holds when it is away, and this one is watched.
  for (const scene of ["shoal", "koi", "jellyfish", "fireflies"]) {
    await page.evaluate((k) => Promise.all([window.hive.settingsSet("appearance.glass.animate", true), window.hive.settingsSet("appearance.wallpaper.kind", k)]), scene);
    await expect(page.locator(`.hm-wallpaper[data-scene="${scene}"] canvas`)).toHaveCount(1);
    await page.waitForTimeout(800);
    const a = await page.screenshot({ clip });
    await page.waitForTimeout(700);
    const b = await page.screenshot({ clip });
    expect(a.equals(b), `${scene} moves`).toBe(false);
    await shot(`5-${scene}`);
    await page.evaluate(() => window.hive.settingsSet("appearance.glass.animate", false));
    await page.waitForTimeout(800);
    const c = await page.screenshot({ clip });
    await page.waitForTimeout(700);
    const d = await page.screenshot({ clip });
    expect(c.equals(d), `${scene} holds still`).toBe(true);
  }
});
