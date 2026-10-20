// Community views end to end (design doc phase 4): `hive plugins install` of the
// tile-list fixture view → it appears in the switcher and the ⌘E cycle → its
// sandboxed iframe sees no privileged API → clicking a tile's row docks the LIVE
// terminal through the hole-punch and typed keys arrive → a flooding plugin
// and a CPU-burning plugin are disabled and the canvas comes back with every
// session intact → a package asking for an unknown permission is refused at
// load → `hive plugins remove` takes the view out of the switcher.
//
// The XDG profile is per run (playwright.config.ts), so the views dir starts
// empty; the CLI runs as a real subprocess exactly as a user would call it.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { TILE_LIST_DIR, dockFromList, framesDrawn, tileListReady, releaseFromList } from "./helpers/tile-list-view";
import { seedAgents } from "./helpers/agents";
import { installedFile } from "./helpers/install";

test.use({ trace: "off" });

let app: ElectronApplication;
let page: Page;
let repo: string;
const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURES = path.join(APP_DIR, "tests/e2e/fixtures/views");
// Own profile (see host-chrome.spec.ts): the app resumes userData under XDG,
// and the HCP socket the CLI reaches lives there too.
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-community-xdg-"));
seedAgents(XDG);
const ENV = { ...process.env, XDG_CONFIG_HOME: XDG } as Record<string, string>;

/** The app's control-plane socket + token (isolated userData under this run's XDG);
 *  set once the app is up so `hive plugins install|remove` can ask it to rescan. */
let hcpEnv: Record<string, string> = {};
/** `hive … --json` as a subprocess; non-zero exits are part of the contract (parsed, not thrown). */
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { cwd: repo, encoding: "utf8", env: { ...ENV, ...hcpEnv } });
  try { return JSON.parse(r.stdout.trim()); } catch { throw new Error(`hive ${args.join(" ")} → exit ${r.status}\n${r.stdout}\n${r.stderr}`); }
};
const toView = (mode: string) => page.evaluate((m) => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: m } })), mode);
const toggleView = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
const reloadViews = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:reload-views")));
const activeView = () => page.getAttribute("[data-active-view]", "data-active-view");
const report = () => page.evaluate(() => (window as unknown as { __hivemindViews: { registered: string[]; refused: Record<string, string> } }).__hivemindViews);
const probe = (sel: string) => page.evaluate((s) => (document.querySelector(s) as unknown as Record<string, unknown> | null)?.__probe ?? null, sel);

test.beforeAll(async () => {
  repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hm-community-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q"); git("config", "user.email", "e2e@test.dev"); git("config", "user.name", "e2e"); git("add", "-A"); git("commit", "-q", "-m", "seed");
  const installed = hive("plugins", "install", TILE_LIST_DIR);
  expect(installed.ok).toBe(true);
  expect(installed.data.members[0].dir).toBe(installedFile(XDG, "tile-list"));
  app = await electron.launch({
    // No --user-data-dir: the profile is isolated by this run's XDG_CONFIG_HOME
    // (playwright.config.ts), and that is where the app's HCP socket lands
    // (<XDG>/hivemind-dev/hcp.sock) for the CLI to reach.
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"],
    cwd: repo,
    // The CPU watchdog's real threshold is 60 % of a core (main/view-packages.ts);
    // on this loaded, GPU-less runner a spinning out-of-process frame gets so
    // little CPU that it reads 2–6 %, so the suite lowers the bar to prove the
    // main → renderer → disable → fallback path, not the number.
    env: { ...ENV, HIVEMIND_VIEW_RUNAWAY_CPU: "1" },
  });
  page = await app.firstWindow();
  page.on("console", (m) => { if (m.type() === "error" && !/Content Security Policy/.test(m.text())) console.log("[r.error]", m.text()); });
  const userData = path.join(XDG, "hivemind-dev");
  const sock = path.join(userData, "hcp.sock"), tokenFile = path.join(userData, "hcp.token");
  await expect.poll(() => fs.existsSync(sock) && fs.existsSync(tokenFile), { timeout: 20_000 }).toBe(true);
  hcpEnv = { HIVEMIND_APP_DATA: userData };
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForSelector(".react-flow__node-terminal .xterm", { timeout: 10_000 });
  await page.locator(".react-flow__node-terminal .xterm").first().evaluate((el) => { (el as unknown as Record<string, unknown>).__probe = "kept"; });
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await app?.close();
  await fs.promises.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(XDG, { recursive: true, force: true }).catch(() => {});
});

test("an installed view is registered after the app's own: ⌘E cycles canvas → windows → tile-list → canvas", async () => {
  await expect.poll(async () => (await report()).registered).toEqual(["windows", "tile-list"]);
  expect(await activeView()).toBe("canvas");
  const seen: string[] = [];
  // One toggle per registered view, so the cycle ends where it started — a lap too many
  // leaves the next test on the wrong view.
  for (let i = 0; i < 3; i++) { await toggleView(); await page.waitForTimeout(150); seen.push((await activeView())!); }
  expect(seen).toEqual(["windows", "tile-list", "canvas"]);
  expect(hive("plugins", "list", "--kind", "view").data.map((v: { id: string; problem: string | null }) => [v.id, v.problem])).toEqual([["tile-list", null]]);
});

test("a view's frame is see-through where no pane covers it: the dark app shows, not white", async () => {
  await toView("windows");
  const frame = page.locator('iframe[name="hm-view:windows"]');
  await expect(frame).toBeVisible();
  await expect.poll(() => page.frame({ name: "hm-view:windows" })?.locator(".w-pane").count() ?? 0).toBeGreaterThan(0);
  // The strip right of the panes, the room's padding: what is behind the frame.
  const box = (await frame.boundingBox())!;
  const shot = await page.screenshot({ clip: { x: box.x + box.width - 5, y: box.y + box.height / 2, width: 3, height: 3 } });
  const rgb = await page.evaluate(async (png) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(0, 0, c.width, c.height).data).filter((_, i) => i % 4 !== 3);
  }, shot.toString("base64"));
  expect(Math.max(...rgb)).toBeLessThan(128);
  await toView("canvas");
});

test("the plugin runs sandboxed: its own origin, no window.hive, no node, no network", async () => {
  await toView("tile-list");
  await page.waitForSelector(tileListReady, { timeout: 15_000 });
  const frame = page.frame({ name: "hm-view:tile-list" });
  expect(frame).toBeTruthy();
  const seen = await frame!.evaluate(async () => ({
    origin: location.origin,
    hive: typeof (window as unknown as { hive?: unknown }).hive,
    process: typeof (globalThis as unknown as { process?: unknown }).process,
    require: typeof (globalThis as unknown as { require?: unknown }).require,
    fetch: await fetch("https://example.com/").then(() => "ok", () => "blocked"),
    parent: (() => { try { return String(Object.keys(window.parent.document).length); } catch { return "blocked"; } })(),
  }));
  expect(seen).toEqual({ origin: "hm-view://tile-list", hive: "undefined", process: "undefined", require: "undefined", fetch: "blocked", parent: "blocked" });
});

test("click a tile's row: the LIVE terminal docks through the hole-punch, typed keys arrive, Escape releases it", async () => {
  const tileId = (await page.locator("[data-surface]").first().getAttribute("data-surface"))!;
  const reveal = (id: string) => page.evaluate((tid) => (document.querySelector("[data-community-view]") as unknown as { __community: { reveal: (id: string) => Promise<{ x: number; y: number; w: number; h: number } | null> } }).__community.reveal(tid), id);
  // The plugin answers `reveal` with where it shows the tile (null until it has
  // received `structure`, which follows `hello` by a message).
  await expect.poll(() => reveal(tileId), { timeout: 10_000 }).toBeTruthy();
  await dockFromList(page, tileId);
  const slot = page.locator(`[data-community-surfaces] [data-tile-slot="${tileId}"]`);
  await expect(slot).toBeVisible({ timeout: 5_000 });
  // The SAME xterm instance, adopted into the overlay slot — never a copy.
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(await probe("[data-community-surfaces] .xterm")).toBe("kept");
  await slot.locator(".xterm-screen").click();
  // Proven through the shell, not the screen: a WebGL terminal leaves no text in the DOM.
  const marker = path.join(XDG, "community-dock-ok");
  await page.keyboard.type(`echo ok > ${marker}`);
  await page.keyboard.press("Enter");
  await expect.poll(() => fs.existsSync(marker), { timeout: 5_000 }).toBe(true);
  // Release from inside the view (its rule), and the surface parks again.
  await releaseFromList(page);
  await expect(slot).toHaveCount(0);
  expect(await probe("#hm-tile-park .xterm")).toBe("kept");
  // Render on demand: frames were drawn for the changes above, and none while nothing changes.
  await page.waitForTimeout(2500);
  const before = await framesDrawn(page);
  expect(before).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(await framesDrawn(page)).toBe(before);
  await toView("canvas");
  await page.waitForSelector(".react-flow__node-terminal .xterm");
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
});

test("`hive plugins install` while the app runs: the CLI asks the app to rescan and the view appears without a restart", async () => {
  // The spec's own XDG profile holds the HCP socket the app opened, so the
  // CLI reaches it exactly as a user's shell would.
  for (const id of ["hostile-flood", "hostile-loop"]) {
    const r = hive("plugins", "install", path.join(FIXTURES, id));
    expect(r.ok).toBe(true);
    expect(r.data.rescanned).toBe(true);
  }
  // No reloadViews() here: the rescan came from the CLI's HCP call.
  await expect.poll(async () => (await report()).registered).toEqual(["windows", "tile-list", "hostile-flood", "hostile-loop"]);
  const seen: string[] = [];
  await toView("canvas");
  for (let i = 0; i < 5; i++) { await toggleView(); await page.waitForTimeout(150); seen.push((await activeView())!); }
  expect(seen).toEqual(["windows", "tile-list", "hostile-flood", "hostile-loop", "canvas"]);
});

test("a flooding plugin and a CPU-burning plugin are disabled; the canvas comes back with the session intact", async () => {
  await expect.poll(async () => (await report()).registered).toEqual(["windows", "tile-list", "hostile-flood", "hostile-loop"]);

  await toView("hostile-flood");
  await expect.poll(activeView, { timeout: 10_000 }).toBe("canvas");
  expect((await report()).refused["hostile-flood"]).toMatch(/^disabled: message flood/);

  await toView("hostile-loop");
  await page.waitForSelector('[data-community-view="hostile-loop"][data-community-ready="1"]', { timeout: 15_000 });
  // It docks the terminal and spins; the frame is out of process (its own
  // renderer pid), so the host's event loop stays responsive with a live
  // terminal in the overlay while main's CPU watchdog counts it out (3 × 2 s).
  await expect(page.locator("[data-community-surfaces] .xterm")).toHaveCount(1);
  const lag = await page.evaluate(() => new Promise<{ p95: number }>((res) => {
    const d: number[] = []; let last = performance.now();
    const iv = setInterval(() => { const n = performance.now(); d.push(n - last - 16); last = n; }, 16);
    setTimeout(() => { clearInterval(iv); d.sort((a, b) => a - b); res({ p95: d[Math.floor(d.length * 0.95)]! }); }, 1500);
  }));
  expect(lag.p95).toBeLessThan(16); // the precise budget (≤ +5 ms vs canvas typing) is the perf harness's job
  console.log(`[views] host loop lag p95 while hostile-loop spins: ${lag.p95.toFixed(1)} ms`);
  await expect.poll(activeView, { timeout: 20_000 }).toBe("canvas");
  expect((await report()).refused["hostile-loop"]).toMatch(/^disabled: runaway/);
  // Disabled for the session: gone from the cycle even after a rescan.
  await reloadViews();
  await expect.poll(async () => (await report()).registered).toEqual(["windows", "tile-list"]);
  await expect(page.locator(".xterm")).toHaveCount(1);
  await page.waitForSelector(".react-flow__node-terminal .xterm");
  expect(await probe(".react-flow__node-terminal .xterm")).toBe("kept");
  await expect(page.locator(".hm-term-root").filter({ hasText: "exited" })).toHaveCount(0);
});

test("a package asking for an unknown permission is refused by install AND by the loader", async () => {
  const r = hive("plugins", "install", path.join(FIXTURES, "greedy"));
  expect(r).toMatchObject({ ok: false, code: "invalid_view" });
  expect(r.error).toMatch(/unknown permission "fs:read"/);
  // Written into an installed copy by hand (bypassing the CLI) it is still refused at load.
  const tame = fs.mkdtempSync(path.join(os.tmpdir(), "hm-greedy-"));
  fs.cpSync(path.join(FIXTURES, "greedy"), tame, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(tame, "hivemind-view.json"), "utf8"));
  fs.writeFileSync(path.join(tame, "hivemind-view.json"), JSON.stringify({ ...manifest, permissions: [] }));
  expect(hive("plugins", "install", tame)).toMatchObject({ ok: true });
  fs.copyFileSync(path.join(FIXTURES, "greedy", "hivemind-view.json"), installedFile(XDG, "greedy", "hivemind-view.json")!);
  await reloadViews();
  await expect.poll(async () => (await report()).refused["greedy"]).toMatch(/unknown permission "fs:read"/);
  expect((await report()).registered).toEqual(["windows", "tile-list"]);
  expect(hive("plugins", "list", "--kind", "view").data.find((v: { id: string }) => v.id === "greedy").problem).toMatch(/unknown permission/);
});

test("`hive plugins remove` of the ACTIVE view: the app rescans, the switcher drops it, the canvas is shown", async () => {
  await toView("tile-list");
  await page.waitForSelector(tileListReady, { timeout: 15_000 });
  const r = hive("plugins", "remove", "tile-list");
  expect(r.ok).toBe(true);
  expect(r.data.rescanned).toBe(true);
  // No reloadViews(): the CLI's rescan did it.
  await expect.poll(async () => (await report()).registered).toEqual(["windows"]);
  await expect.poll(activeView).toBe("canvas");
  await expect(page.locator(".xterm")).toHaveCount(1);
  expect(hive("plugins", "list", "--kind", "view").data.map((v: { id: string }) => v.id)).toEqual(["greedy", "hostile-flood", "hostile-loop"]);
});
