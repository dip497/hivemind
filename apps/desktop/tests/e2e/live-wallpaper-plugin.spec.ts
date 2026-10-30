// A package's live wallpaper in the built app: installed while the app was closed, it is offered
// once as the background and Use draws it, in its sandboxed frame, told each agent's creature and
// where their tiles are, by handles that are not the tiles' ids; the pointer over a creature names
// its agent and a click there goes to its tile; it runs on while the person is idle or in another
// window, as a video does, and stops only while the window is hidden; its Colour switch reaches it,
// and See-through leaves the Layers panel clear glass over it. A wallpaper that names creatures it
// was never sent is turned off for the session, the plain background showing instead;
// one that says a creature is under the pointer while the pointer is over a tile is not heard; one
// that takes the keyboard is turned off, what had the keyboard getting it back; a package switched
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

test("offered once as the background, Use draws it, told each agent's creature and where their tiles are", async () => {
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
  await zoomOut();
  await expect.poll(() => openWater(40)).not.toBeNull();
  const water = (await openWater(40))!;
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

test("a wallpaper that takes the keyboard is turned off, and what had the keyboard gets it back", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/rogue/liar"));
  const frame = await wallpaperFrame("@e2e/rogue/liar");
  // The keyboard on a row of the Tiles list: nothing but the guard would give it back there.
  const [tile] = await tiles();
  const focusedRow = () => page.evaluate(() => document.activeElement?.getAttribute("data-layer-tile") ?? null);
  await page.locator(`[data-layer-tile="${tile}"]`).focus();
  await expect.poll(focusedRow).toBe(tile);
  await frame.evaluate(() => (window as unknown as Liar).steal());
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

test("resting your hands or working in another window does not stop it, nor a video: only a hidden window does", async () => {
  await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/pond/dots"));
  const frame = await wallpaperFrame("@e2e/pond/dots");
  const mode = () => frame.evaluate(() => (window as unknown as { seen: { modes: string[] } }).seen.modes.at(-1));
  await page.bringToFront();
  await expect.poll(mode).toBe("run");
  // Another window in front, as the page sees it (the private X display has no window manager to move
  // focus), and over 30 seconds with no input: the window is still in sight.
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event("blur")); });
  await page.waitForTimeout(33_000);
  expect(await mode()).toBe("run");
  // A video background plays on the same way.
  const glassWas = await page.evaluate(() => window.hive.settingsGet().then((s) => s.appearance.glass.enabled));
  const file = path.resolve("tests/fixtures/settings-motion.webm");
  await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, file);
  await page.evaluate(async () => {
    const media = await window.hive.pickMedia("background");
    if (!media) throw new Error("No test media");
    await window.hive.settingsSet("appearance.glass.enabled", true);
    await window.hive.settingsSet("appearance.wallpaper", { kind: "video", videoSrc: media.url });
  });
  const video = page.locator("video.hm-wp-video");
  const playedTo = () => video.evaluate((v: HTMLVideoElement) => v.paused ? -1 : v.currentTime);
  await expect.poll(playedTo).toBeGreaterThan(0);
  const at = await playedTo();
  await expect.poll(playedTo).not.toBe(at);
  expect(await page.evaluate(() => document.hasFocus())).toBe(false);
  // Hidden, it stops; shown again, it plays.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.evaluate(() => { delete (document as { hidden?: boolean }).hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(playedTo).toBeGreaterThan(0);
  await page.evaluate(() => { delete (document as { hasFocus?: () => boolean }).hasFocus; });
  await page.evaluate((was) => Promise.all([window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/pond/dots"), window.hive.settingsSet("appearance.glass.enabled", was)]), glassWas);
  await page.bringToFront();
});

test("its Colour switch reaches it, and See-through frosts the panels and the tools in one click, the Layers panel clear glass over it", async () => {
  const before = await page.evaluate(() => window.hive.settingsGet().then((s) => s.appearance));
  const onDisk = () => JSON.parse(fs.readFileSync(env.HIVE_SETTINGS!, "utf8")).appearance;
  try {
    await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "@e2e/pond/dots"));
    const frame = await wallpaperFrame("@e2e/pond/dots");
    const colour = () => frame.evaluate(() => (window as unknown as { seen: { look: { colour: boolean } } }).seen.look.colour);
    const was = await colour();
    if (await page.locator("[data-settings-body]").count() === 0) await page.locator('[aria-label="settings"]').click();
    await page.locator('[data-settings-page="appearance"]').click();
    await page.getByRole("switch", { name: "Draw Dots in its own colours" }).click();
    await expect.poll(colour).toBe(!was);
    await page.getByRole("button", { name: "See-through" }).click();
    await expect.poll(() => onDisk()?.glass).toMatchObject({ enabled: true, contentGlass: true, opacity: 0.5, blur: 14, contentOpacity: 0.45 });
    await expect(page.locator("[data-settings-body]")).toContainText("It shows through the frosted panels and tiles");
    await shot("5-see-through");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    // Over another background the panel stops at 68% so its names stay legible; over a live
    // wallpaper its blur does that, and it takes a third of the panel tint: clear glass.
    const alpha = () => page.locator(".hm-layers").first().evaluate((el) => {
      const m = /\/\s*([\d.]+)\)\s*$/.exec(getComputedStyle(el).backgroundColor);
      return m ? Number(m[1]) : 1;
    });
    await expect.poll(alpha).toBeCloseTo(0.5 / 3, 2);
    // Asked for less transparency, it is solid over it too.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await expect.poll(alpha).toBe(1);
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await expect.poll(alpha).toBeCloseTo(0.5 / 3, 2);
    await page.evaluate(() => window.hive.settingsSet("appearance.wallpaper.kind", "mono"));
    await expect.poll(alpha).toBeCloseTo(0.68, 2);
  } finally {
    await page.evaluate((a) => window.hive.settingsSet("appearance", a), before);
  }
});
