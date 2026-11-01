// The phone looks like the computer (docs/design/phone-look-2026-11-01.md), over the real network:
// the computer's colours and terminal colours reach an open phone page without a reload; its photo
// wallpaper is drawn there from the same file, kept by revision; a package's live wallpaper runs
// there on the views' origin, told the computer's colours, still when motion is reduced, unable to
// reach the network, and turned off for the session when it misbehaves.
import { test, expect, chromium, type Browser, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { hiveNetBuilt, ownNetwork, person } from "./helpers/multiplayer";
import { connectPage, offerToConnect } from "./helpers/phone";
import { stopDaemons } from "./helpers/daemons";
import { installPlugin } from "./helpers/install";
import { PRESETS } from "@hivemind/core/settings-schema";

const WWW = path.resolve("../../crates/hive-web/www");
const hiveWebBuilt = () => fs.existsSync(path.join(WWW, "pkg", "hive_web_bg.wasm")) && fs.existsSync(path.join(WWW, "js", "look.js"));
const WALLPAPERS = path.resolve("tests/e2e/fixtures/wallpapers");
/** Where the screenshots of each state go, and a real package of live scenes to show, when asked for. */
const SHOTS = process.env.PHONE_LOOK_SHOTS;
const SCENES = process.env.PHONE_LOOK_SCENES;

let root: string;
let browser: Browser | undefined;
const apps: ElectronApplication[] = [];
const procs: ChildProcess[] = [];
test.beforeEach(() => { root = fs.mkdtempSync("/tmp/hm-phone-look-"); });
test.afterEach(async () => {
  await browser?.close();
  browser = undefined;
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const a of apps.splice(0)) await a.close();
  stopDaemons(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim(), name);

test("an open phone page takes the computer's colours, its photo from the same file and its live wallpaper, sandboxed, as the computer changes them", async () => {
  test.skip(!hiveNetBuilt() || !hiveWebBuilt(), "build hive-net (cargo build in crates/hive-net) and the page (crates/hive-web/build.sh) first");
  test.setTimeout(300_000);
  const net = await ownNetwork(root, procs, "closed", WWW);
  const repo = path.join(root, "api");
  fs.mkdirSync(repo);
  execSync("git init -q", { cwd: repo });
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const config = path.join(root, "desktop", "hivemind");
  for (const pkg of ["pond", "rogue"]) installPlugin(path.dirname(config), path.join(WALLPAPERS, pkg));
  if (SCENES) installPlugin(path.dirname(config), SCENES);
  const desktop = await person(root, "desktop", repo, apps, { HOME: home });
  expect(await desktop.evaluate((l) => window.hive.useNetwork(l), net.link)).toMatchObject({ admission: "enrolled" });
  const me = await desktop.evaluate(() => window.hive.identity());
  const set = (at: string, value: unknown) => desktop.evaluate(([p, v]) => window.hive.settingsSet(p as string, v), [at, value] as const);
  await set("appearance.wallpaper.kind", "none");

  const link = await offerToConnect(desktop, true);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const page = await context.newPage();
  page.on("console", (m) => console.log(`phone: ${m.text()}`));
  const leaks: string[] = [];
  context.on("request", (r) => { if (r.url().includes("/leak")) leaks.push(r.url()); });
  await page.goto(link);
  await connectPage(page, desktop);
  await expect(page.locator("[data-paired]")).toHaveAttribute("data-paired", me.deviceId, { timeout: 30_000 });
  await desktop.keyboard.press("Escape");

  // Its colours, and its terminal's, follow the computer's without a reload.
  await set("appearance.palette.bg", "#123456");
  await set("appearance.terminal.background", "#0a1b2c");
  await expect.poll(() => token(page, "canvas"), { timeout: 10_000 }).toBe("#123456");
  await expect.poll(() => token(page, "term-bg"), { timeout: 10_000 }).toBe("#0a1b2c");
  await shot(page, "dark-theme");
  const loads = await page.evaluate(() => performance.getEntriesByType("navigation").length);
  // A light theme, whole: its palette and its terminal.
  const latte = PRESETS["catppuccin-latte"]!;
  await desktop.evaluate((p) => window.hive.settingsPatch([{ path: "appearance.mode", value: p.mode }, { path: "appearance.palette", value: { ...p.palette, bg: "#f4efe6", fg: "#1b1b1f" } }, { path: "appearance.terminal", value: p.terminal }]), latte);
  await expect.poll(() => token(page, "canvas"), { timeout: 10_000 }).toBe("#f4efe6");
  await expect.poll(() => token(page, "text"), { timeout: 10_000 }).toBe("#1b1b1f");
  await expect.poll(() => token(page, "term-bg"), { timeout: 10_000 }).not.toBe("#0a1b2c");
  expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(loads);
  await shot(page, "light-theme");

  // A photo, behind glass: the same file the computer draws, whole, not a smaller copy.
  const picture = await desktop.evaluate(() => {
    const c = document.createElement("canvas");
    [c.width, c.height] = [1200, 1920];
    const g = c.getContext("2d")!;
    const fill = g.createLinearGradient(0, 0, 1200, 1920);
    fill.addColorStop(0, "#0f4c5c");
    fill.addColorStop(1, "#e36414");
    g.fillStyle = fill;
    g.fillRect(0, 0, 1200, 1920);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `hsl(${(i * 37) % 360} 70% 60% / 0.5)`;
      g.beginPath();
      g.arc((i * 97) % 1200, (i * 193) % 1920, 10 + (i % 40), 0, Math.PI * 2);
      g.fill();
    }
    return c.toDataURL("image/png");
  });
  const media = path.join(root, "desktop", "media");
  fs.mkdirSync(media, { recursive: true });
  const bytes = Buffer.from(picture.split(",")[1]!, "base64");
  fs.writeFileSync(path.join(media, "background-1.png"), bytes);
  const signal = PRESETS.signal!;
  await desktop.evaluate((p) => window.hive.settingsPatch([{ path: "appearance.mode", value: p.mode }, { path: "appearance.palette", value: { ...p.palette, bg: "#191919" } }, { path: "appearance.terminal", value: p.terminal }]), signal);
  await set("appearance.glass.enabled", true);
  await set("appearance.wallpaper.imageSrc", "hivemedia://media/background-1.png");
  await set("appearance.wallpaper.kind", "image");
  const photo = page.locator("[data-wallpaper-photo]");
  await expect(photo).toBeAttached({ timeout: 20_000 });
  await expect.poll(() => photo.evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 10_000 }).toBe(1200);
  const kept = () => page.evaluate(async () => {
    const cache = await caches.open("hivemind-wallpaper");
    return Promise.all((await cache.keys()).map(async (k) => (await (await cache.match(k))!.arrayBuffer()).byteLength));
  });
  expect(await kept()).toEqual([bytes.length]);
  await shot(page, "photo");
  // Kept: the page opened again shows it before asking the computer for it again.
  await page.reload();
  await expect(page.locator("[data-wallpaper-photo]")).toBeAttached({ timeout: 20_000 });
  expect(await kept()).toEqual([bytes.length]);

  // A package's live wallpaper runs there, told the computer's colours.
  await set("appearance.wallpaper.kind", "@e2e/pond/dots");
  const frame = page.locator("[data-live-wallpaper]");
  await expect(frame).toHaveAttribute("data-drawn", "1", { timeout: 30_000 });
  await expect(frame).toHaveAttribute("src", new RegExp(`^${net.views!}/\\?s=`));
  const scene = page.frameLocator("[data-live-wallpaper]").frameLocator("iframe[data-view]");
  const seen = () => scene.locator("body").evaluate(() => (window as unknown as { seen: { look: { page: string } | null; modes: string[] } }).seen);
  await expect.poll(async () => (await seen()).look?.page, { timeout: 10_000 }).toBe("#191919");
  expect((await seen()).modes.at(-1) ?? "run").toBe("run");
  // It is never in the keyboard's way, and reaches nothing beyond its own files.
  expect(await frame.evaluate((f: HTMLIFrameElement) => [f.inert, f.tabIndex])).toEqual([true, -1]);
  expect(await scene.locator("body").evaluate(async () => {
    try { await fetch(`${location.origin}/leak`); return "reached"; } catch { return "blocked"; }
  })).toBe("blocked");
  await page.waitForTimeout(1_000);
  expect(leaks).toEqual([]);
  await shot(page, "live-wallpaper");
  // Covered by a solid screen, it holds; shown again, it runs.
  await page.evaluate(() => (location.hash = "start"));
  await expect.poll(async () => (await seen()).modes.at(-1), { timeout: 10_000 }).toBe("hold");
  await page.evaluate(() => (location.hash = "home"));
  await expect.poll(async () => (await seen()).modes.at(-1), { timeout: 10_000 }).toBe("run");
  // Less motion asked for: a still frame.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => (await seen()).modes.at(-1), { timeout: 10_000 }).toBe("still");

  // One that misbehaves is turned off, and the page draws Mono in its place.
  await set("appearance.wallpaper.kind", "@e2e/rogue/flood");
  await expect(page.locator("[data-wallpaper-layer]")).toHaveAttribute("data-scene", "mono", { timeout: 30_000 });
  await expect(frame).toHaveCount(0);

  // What a guest is shown of a computer whose wallpaper is a file or a package: the default scene.
  await set("appearance.wallpaper.kind", "mono");
  await shot(page, "guest-default-scene");
  if (SCENES) {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await set("appearance.wallpaper.kind", "@dip497/live-scenes/koi");
    await expect(page.locator("[data-live-wallpaper]")).toHaveAttribute("data-drawn", "1", { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    await shot(page, "live-scenes-koi");
    if (process.env.PHONE_LOOK_MEASURE) {
      // The page's main-thread work each second, on a CPU slowed 4x, running, then still.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const busy = async (ms: number) => {
        const at = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "TaskDuration")!.value;
        const before = await at();
        await page.waitForTimeout(ms);
        return ((await at()) - before) / (ms / 1000);
      };
      const running = await busy(10_000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForTimeout(1_000);
      const still = await busy(10_000);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await set("appearance.wallpaper.kind", "mono");
      await page.waitForTimeout(1_000);
      const plain = await busy(10_000);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await set("appearance.wallpaper.kind", "@dip497/live-scenes/koi");
      await expect(page.locator("[data-live-wallpaper]")).toHaveAttribute("data-drawn", "1", { timeout: 30_000 });
      const unthrottled = await busy(10_000);
      console.log(`measured: koi, main-thread busy on a 4x slower CPU ${(running * 100).toFixed(1)}% running, ${(still * 100).toFixed(1)}% still, ${(plain * 100).toFixed(1)}% with Mono; unthrottled ${(unthrottled * 100).toFixed(1)}%`);
    }
  }
});
