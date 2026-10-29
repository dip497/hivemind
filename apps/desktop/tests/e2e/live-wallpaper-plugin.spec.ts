// A package's live wallpaper in the built app: installed while the app was closed, it is offered
// once as the background and Use draws it, in its sandboxed frame, told each agent's creature and
// where their tiles are, by handles that are not the tiles' ids; the pointer over a creature names
// its agent and a click there goes to its tile, on the app's own scenes too. A wallpaper that names
// creatures it was never sent is turned off for the session, the plain background showing instead;
// one that says a creature is under the pointer while the pointer is over a tile is not heard; one
// that takes the keyboard is turned off, the terminal that had it getting it back; a package switched
// off stops its wallpaper in every window; and a view the repository ships named like a wallpaper's
// origin is never served there.
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
const wallpaperFrame = async (id: string): Promise<Frame> => {
  await expect.poll(() => page.frame({ name: `hm-wallpaper:${id}` }) !== null).toBe(true);
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

test("offered once as the background, Use draws it, told each agent's creature and where their tiles are", async () => {
  const offer = page.locator('[data-start-view-offer="@e2e/pond"]');
  await expect(offer).toContainText("Pond is installed. Use Dots as your background?");
  await shot("1-offer");
  await offer.locator('[data-use-start-wallpaper="@e2e/pond/dots"]').click();
  await expect(offer).toHaveCount(0);
  await expect(page.locator('.hm-live-frame[data-drawn][data-wallpaper="@e2e/pond/dots"]')).toBeVisible();
  expect(await page.evaluate(() => window.hive.settingsGet().then((s) => s.appearance.wallpaper.kind))).toBe("@e2e/pond/dots");
  const frame = await wallpaperFrame("@e2e/pond/dots");
  const ids = await tiles();
  await expect.poll(() => frame.evaluate(() => (window as unknown as { seen: { creatures: Array<{ agent: string }> } }).seen.creatures.map((c) => c.agent)))
    .toEqual(ids.map(() => "pond"));
  // Each agent's tile, by its creature's id: a handle, never the tile's own id, name, folder or output.
  const told = await frame.evaluate(() => (window as unknown as { seen: { creatures: Array<{ id: string }>; tiles: Array<{ id?: string }>; look: Record<string, unknown> } }).seen);
  const handles = told.creatures.map((c) => c.id);
  expect(told.tiles.map((t) => t.id).filter(Boolean).sort()).toEqual([...handles].sort());
  expect(handles.filter((h) => ids.includes(h))).toEqual([]);
  expect(Object.keys(told.look).sort()).toEqual(["attention", "colour", "dark", "mono", "page", "text"]);
  await shot("2-drawn");
});

test("the pointer over a creature names its agent, and a click there goes to its tile", async () => {
  const frame = await wallpaperFrame("@e2e/pond/dots");
  const handle = await frame.evaluate(() => (window as unknown as { seen: { creatures: Array<{ id: string }> } }).seen.creatures[0]!.id);
  await zoomOut();
  await expect.poll(() => openWater(40)).not.toBeNull();
  const water = await openWater(40);
  expect(water, "some empty canvas to put the creature on").not.toBeNull();
  await frame.evaluate(([id, at]) => (window as unknown as { place: (id: string, at: unknown) => void }).place(id, at), [handle, water!] as const);
  // Its tile is not selected, so going to it shows.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.mouse.move(water!.x + 2, water!.y + 2);
  await page.mouse.move(water!.x, water!.y);
  const label = page.locator(".hm-live-label");
  await expect(label).toHaveCount(1);
  const tile = await label.getAttribute("data-creature");
  expect(await tiles()).toContain(tile);
  await expect(label).toContainText("Pond");
  await shot("3-hover");
  await page.mouse.click(water!.x, water!.y);
  await expect(page.locator(`.react-flow__node[data-id="${tile}"].selected`)).toHaveCount(1);
  await expect.poll(() => frame.evaluate(() => (window as unknown as { seen: { clicks: Array<string | null> } }).seen.clicks)).toContain(handle);
  // Off it, the label goes.
  await page.mouse.move(water!.x + 200, water!.y);
  await expect(label).toHaveCount(0);
});

test("a wallpaper that names creatures it was never sent is turned off, and the plain background shows", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/flood"));
  await expect(page.getByText(/The Flood live wallpaper was turned off: \d+ malformed or refused messages/)).toBeVisible();
  await expect(page.locator('.hm-wallpaper[data-scene="mono"]')).toHaveCount(1);
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await shot("4-turned-off");
});

type Liar = { seen: { creatures: Array<{ id: string }> }; say: (m: unknown) => void; steal: () => void };
const middleOf = async (tile: string) => {
  const b = (await page.locator(`.react-flow__node[data-id="${tile}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test("what a wallpaper says is under the pointer counts only over open water, and the name goes with the pointer", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/liar"));
  const frame = await wallpaperFrame("@e2e/rogue/liar");
  await expect.poll(() => frame.evaluate(() => (window as unknown as Liar).seen.creatures.length)).toBe(2);
  const handle = await frame.evaluate(() => (window as unknown as Liar).seen.creatures[0]!.id);
  const say = () => frame.evaluate((id) => (window as unknown as Liar).say({ type: "hover", id }), handle);
  const label = page.locator(".hm-live-label");
  const [tile] = await tiles();
  const onTile = await middleOf(tile!);
  // Over a tile, a creature it says is under the pointer is not heard. Nothing shows that it was
  // not, so the test gives it a few frames.
  await page.mouse.move(onTile.x, onTile.y);
  await say();
  await page.waitForTimeout(300);
  await expect(label).toHaveCount(0);
  // Over the water it is, and the name goes with the pointer.
  const water = (await openWater(60))!;
  await page.mouse.move(water.x, water.y);
  await say();
  await expect(label).toHaveCount(1);
  const was = (await label.boundingBox())!;
  await page.mouse.move(water.x - 40, water.y - 40, { steps: 4 });
  await expect.poll(async () => (await label.boundingBox())!.x).toBeLessThan(was.x - 30);
  // Onto a tile, the name goes, though the wallpaper never says so.
  await page.mouse.move(onTile.x, onTile.y);
  await expect(label).toHaveCount(0);
});

test("a wallpaper that takes the keyboard is turned off, and the terminal that had it gets it back", async () => {
  const frame = await wallpaperFrame("@e2e/rogue/liar");
  const [tile] = await tiles();
  const focusedTile = () => page.evaluate(() => document.activeElement?.closest(".react-flow__node")?.getAttribute("data-id") ?? null);
  const at = await middleOf(tile!);
  await page.mouse.click(at.x, at.y);
  await expect.poll(focusedTile).toBe(tile);
  await frame.evaluate(() => (window as unknown as Liar).steal());
  await expect(page.getByText(/The Liar live wallpaper was turned off: it took the keyboard/)).toBeVisible();
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await expect.poll(focusedTile).toBe(tile);
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

test("on the app's own scenes too: the pointer over a shark names its agent, and a click there goes to its tile", async () => {
  // Motion off: one settled frame, so a shark stays where the pointer finds it.
  await page.evaluate(() => Promise.all([window.hive.settingsSet("appearance.glass.animate", false), window.hive.settingsSet("appearance.wallpaper.kind", "shoal")]));
  await expect(page.locator('.hm-wallpaper[data-scene="shoal"] canvas')).toHaveCount(1);
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await zoomOut();
  await page.waitForTimeout(1500);
  await shot("5-shoal-before");
  // Over the open water, a step at a time, until a shark is under the pointer.
  const label = page.locator(".hm-live-label");
  const found = await (async () => {
    for (let y = 120; y < 860; y += 24) {
      for (let x = 360; x < 1420; x += 24) {
        const free = await page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.classList.contains("react-flow__pane"), [x, y]);
        if (!free) continue;
        await page.mouse.move(x, y);
        if (await label.count()) return { x, y };
      }
    }
    return null;
  })();
  expect(found, "a shark somewhere on the open water").not.toBeNull();
  const key = await label.getAttribute("data-creature");
  expect(await tiles()).toContain(key);
  await shot("5-shoal-hover");
  await page.mouse.click(found!.x, found!.y);
  await expect(page.locator(`.react-flow__node[data-id="${key}"].selected`)).toHaveCount(1);
});
