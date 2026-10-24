// Sounds and the notice desk (docs/plans/sounds-and-themes.md S1–S3, T4): with two windows open,
// ten stand-in agents (fixtures/fake-agent.cjs) that finish together make one burst in main's
// Recent, played in one window only, for all ten (one of them selected in a window that lost the
// focus), and their OS pop-ups gathered (the first, then one for the other nine). Play in Settings
// and `hive notifications play` add played entries; an applied theme's sound plays instead of the
// built-in one and Recent names its pack, a file that does not decode plays the built-in and says
// why, and a window gets no file but the applied theme's. Screenshots of the Sounds section go to
// $SOUNDS_SHOTS when set.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopDaemons } from "./helpers/daemons";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const FIXTURE = path.join(__dirname, "fixtures", "fake-agent.cjs");
const XDG = process.env.XDG_CONFIG_HOME!;
const SHOTS = process.env["SOUNDS_SHOTS"];

let app: ElectronApplication;
let page: Page;
let repo: string;
let fakeBin: string;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sounds-home-"));
let userData = "";
let lastProject: string | null = null;

function onPath(bin: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    const p = path.join(d, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  throw new Error(`${bin} not on PATH`);
}

/** `hive …` as the person at this machine runs it. */
function hive(args: string[]) {
  const r = spawnSync(onPath("bun"), [CLI, ...args], { cwd: repo, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_APP_DATA: userData } });
  let json: any;
  try { json = JSON.parse(r.stdout.trim().split("\n").pop() || ""); } catch { /* not json */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** A 16-bit mono WAV of `seconds` of a sine at `hz`, at full scale: louder than the cap lets play. */
function wav(seconds: number, hz: number): Buffer {
  const rate = 22_050;
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(32767 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return b;
}

const openNotifications = async (): Promise<void> => {
  if (await page.locator("[data-settings-body]").count() === 0) await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="notifications"]').click();
  await expect(page.locator("[data-settings-sounds]")).toBeVisible();
};

/** Recent as the Sounds section lists it: moment, agents, sound, pop-ups, pack. */
const recent = () => page.locator("[data-recent-sound]").evaluateAll((rows) => rows.map((r) => ({
  moment: r.getAttribute("data-recent-sound"), agents: Number(r.getAttribute("data-agents")), sound: r.getAttribute("data-sound"),
  popups: Number(r.getAttribute("data-popups")), pack: r.getAttribute("data-pack"),
})));

test.beforeAll(async () => {
  test.setTimeout(180_000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sounds-"));
  execSync("git init -q", { cwd: repo });
  fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "hm-sounds-bin-"));
  const shim = path.join(fakeBin, "claude");
  fs.writeFileSync(shim, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} claude "$@"\n`);
  fs.chmodSync(shim, 0o755);
  app = await electron.launch({
    // A window may not start sound before a press or key: in a test nobody presses first.
    args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
    cwd: repo,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>,
  });
  page = await app.firstWindow();
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  lastProject = await page.evaluate(() => localStorage.getItem("hivemind:last-project"));
  userData = path.join(XDG, "hivemind-dev");
  await expect.poll(() => fs.existsSync(path.join(userData, "drive.sock")), { timeout: 20_000 }).toBe(true);
});

test.afterAll(async () => {
  await page?.evaluate((v) => { if (v === null) localStorage.removeItem("hivemind:last-project"); else localStorage.setItem("hivemind:last-project", v); }, lastProject).catch(() => {});
  // The next spec on this profile starts with sounds as they were: off.
  hive(["notifications", "set", "sound", "off"]);
  hive(["notifications", "set", "sounds.done", "off"]);
  await app?.close();
  stopDaemons(XDG);
  try { execSync(`pkill -f "fixtures/fake-agent\\.cjs claude "`, { stdio: "ignore" }); } catch { /* none */ }
  for (const d of [repo, fakeBin, home]) fs.rmSync(d, { recursive: true, force: true });
});

test("ten agents finishing together in two windows make one burst: one sound for ten, played, and their pop-ups gathered", async () => {
  test.setTimeout(180_000);
  await openNotifications();
  await page.getByRole("switch", { name: "Play a sound" }).click();
  // A change the window has not heard of yet (a hand edit, a `hive` whose reload is on its way):
  // the switch below writes its own setting only, so this one stays.
  const settingsFile = path.join(XDG, "hivemind", "settings.json");
  await expect.poll(() => JSON.parse(fs.readFileSync(settingsFile, "utf8")).notifications?.sound, { timeout: 5_000 }).toBe(true);
  const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...raw, notifications: { ...raw.notifications, popupText: true } }, null, 2));
  await page.getByRole("switch", { name: /^Sound on Finished/ }).click();
  await expect.poll(() => hive(["notifications", "show", "--json"]).json?.sounds?.done, { timeout: 5_000 }).toBe(true);
  expect(JSON.parse(fs.readFileSync(settingsFile, "utf8")).notifications.popupText).toBe(true);
  expect(hive(["notifications", "set", "popupText", "off"]).code).toBe(0);
  if (SHOTS) await page.locator("[data-settings-sounds]").screenshot({ path: path.join(SHOTS, "sounds-dark.png") });
  await page.keyboard.press("Escape");

  const [second] = await Promise.all([app.waitForEvent("window"), page.evaluate(() => window.hive.newWindow())]);
  await second.waitForSelector(".react-flow", { timeout: 15_000 });
  // How many sounds each window is asked to play: main sends each to one window only.
  for (const w of [page, second]) await w.evaluate(() => { const c = window as unknown as { soundsHeard: number }; c.soundsHeard = 0; window.hive.onSound?.(() => { c.soundsHeard++; }); });

  // Each waits for one file, so all ten finish at once. Reported (no `--no-report`): a workflow's
  // background worker tells no one when it finishes.
  const go = path.join(repo, ".go");
  const tiles: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = hive(["ctl", "spawn", "--agent", "claude", "--name", `sound-${i}`, "--prompt", `while [ ! -f ${go} ]; do sleep 0.05; done; echo done-${i}`, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    tiles.push(r.json.tile);
  }
  for (const t of tiles) await expect(page.locator(`.hm-layers [data-layer-tile="${t}"] [aria-label="working"]`)).toHaveCount(1, { timeout: 30_000 });
  // One of them selected in this window: looked at only while the window has the focus, so its
  // finish still counts in the sound once the person is away.
  await page.locator(`.hm-layers [data-layer-tile="${tiles[0]}"]`).click();
  await expect(page.locator(`.hm-layers [data-layer-tile="${tiles[0]}"]`)).toHaveAttribute("data-active", "true");
  // Away from the app: OS pop-ups show only while no window has the focus.
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.blur(); });
  fs.writeFileSync(go, "");

  // Read through `hive`, which touches no window: a click would give one the focus back.
  const done = () => (hive(["notifications", "recent", "--json"]).json?.recent ?? []).filter((r: { moment: string }) => r.moment === "done");
  await expect.poll(done, { timeout: 30_000 }).toEqual([expect.objectContaining({ moment: "done", agents: 10, sound: "played", count: 10 })]);
  // The pop-ups: the first at once, the other nine gathered into one 1.5 s later.
  await expect.poll(() => done()[0]?.popups, { timeout: 5_000 }).toBe(2);
  const heard = await Promise.all([page, second].map((w) => w.evaluate(() => (window as unknown as { soundsHeard: number }).soundsHeard)));
  expect(heard.filter((n) => n > 0), `sounds per window: ${heard}`).toHaveLength(1);
  // Settings lists the same burst.
  await openNotifications();
  await expect.poll(async () => (await recent()).filter((r) => r.moment === "done"), { timeout: 5_000 })
    .toEqual([{ moment: "done", agents: 10, sound: "played", popups: 2, pack: null }]);

  await page.getByRole("button", { name: "Play the Needs you sound" }).click();
  await expect.poll(async () => (await recent())[0], { timeout: 10_000 }).toMatchObject({ moment: "needs", sound: "played" });

  const played = hive(["notifications", "play", "error", "--json"]);
  expect(played.code, played.stderr).toBe(0);
  expect(played.json).toMatchObject({ moment: "error", played: true });
  await second.close();
});

test("an applied theme's sound plays instead of the built-in one, and Recent names its pack; without it the built-in plays", async () => {
  // As applying a theme leaves it (T3): the file copied beside settings.json, its URL in the record.
  const settings = path.join(XDG, "hivemind", "settings.json");
  const media = path.join(path.dirname(settings), "media");
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, "theme-e2e-needs.wav"), wav(5, 440));
  const withTheme = (theme: unknown) => {
    const raw = JSON.parse(fs.readFileSync(settings, "utf8"));
    fs.writeFileSync(settings, JSON.stringify({ ...raw, appearanceExtra: { ...(raw.appearanceExtra ?? {}), theme } }, null, 2));
    expect(hive(["notifications", "set", "volume", "0.6"]).code).toBe(0); // and the app reloads
  };
  const harbour = (sounds: Record<string, string>) => ({
    id: "@e2e/pack/harbour", name: " Harbour ", version: "1.0.0", appliedAt: Date.now(), before: { appearance: {}, extra: {} }, sounds,
  });
  // Over the 1 MiB a window is handed: refused before it is read.
  fs.writeFileSync(path.join(media, "theme-e2e-big.wav"), Buffer.alloc(1024 * 1024 + 1));
  withTheme(harbour({ needs: "hivemedia://media/theme-e2e-needs.wav", error: "hivemedia://media/theme-e2e-big.wav" }));
  expect(hive(["notifications", "play", "needs", "--json"]).json).toMatchObject({ played: true, pack: "Harbour" });
  await openNotifications();
  await expect.poll(async () => (await recent())[0], { timeout: 10_000 }).toMatchObject({ moment: "needs", sound: "played", pack: "Harbour" });

  // A window gets the applied theme's sounds and no other file: not one on disk, not another
  // media file, and not one too large.
  const refused = (url: string) => page.evaluate((u) => window.hive.themeSoundBytes!(u).then(() => "read", (e: Error) => e.message), url);
  expect(await refused("hivemedia://media/theme-e2e-needs.wav")).toBe("read");
  expect(await refused("file:///etc/hostname")).toMatch(/not one of the applied theme's sounds/);
  fs.writeFileSync(path.join(media, "theme-e2e-other.wav"), wav(0.2, 440));
  expect(await refused("hivemedia://media/theme-e2e-other.wav")).toMatch(/not one of the applied theme's sounds/);
  expect(await refused("hivemedia://media/theme-e2e-big.wav")).toMatch(/too large/);

  // A file that is not a sound, under a name the window has not decoded before: the built-in
  // plays, and both the answer and Recent say why.
  fs.writeFileSync(path.join(media, "theme-e2e-garbage.wav"), Buffer.from("not a sound at all, only text"));
  withTheme(harbour({ needs: "hivemedia://media/theme-e2e-garbage.wav" }));
  const fallback = hive(["notifications", "play", "needs", "--json"]).json;
  expect(fallback).toMatchObject({ played: true, why: expect.stringMatching(/did not play/) });
  expect(fallback.pack).toBeUndefined();
  await expect.poll(async () => (await page.locator("[data-recent-sound]").first().textContent()) ?? "", { timeout: 10_000 }).toMatch(/played: Harbour's sound did not play/);

  withTheme(undefined);
  const after = hive(["notifications", "play", "needs", "--json"]).json;
  expect(after).toMatchObject({ played: true });
  expect(after.pack).toBeUndefined();
  if (SHOTS) await page.locator("[data-settings-sounds]").screenshot({ path: path.join(SHOTS, "sounds-recent-dark.png") });
});
