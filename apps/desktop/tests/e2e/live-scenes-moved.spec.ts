// Shoal, Koi Pond, Jellyfish and Fireflies moved out of the app into the Live scenes package. A
// settings.json from before, Koi Pond chosen, names the package's Koi Pond once the app starts
// (migration 0008); the plain background shows, and Settings ▸ Appearance says what it comes in
// and installs that from HiveHub, after which it draws, with nothing else to choose, and HiveHub's
// list says the package is installed. Make your own
// there hands an agent the prompt for a live wallpaper.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hm-live-scenes-moved-"));
const xdg = path.join(root, "config");
const settingsFile = path.join(xdg, "hivemind", "settings.json");
const onDisk = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const KOI = "@dip497/live-scenes/koi";
/** Set to a folder to keep a picture of each step. */
const shots = process.env.LIVE_SCENES_SHOTS;

let app: ElectronApplication;
let page: Page;
const shot = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };

/** HiveHub, as a file: it lists Live scenes, holding a Koi Pond (the suite's dots wallpaper under
 *  that name), every file with its checksum. */
function hub(): string {
  const dots = path.resolve("tests/e2e/fixtures/wallpapers/pond/wallpapers/dots/main.js");
  const files: Record<string, string> = {
    "hivemind-package.json": JSON.stringify({ apiVersion: 2, id: "@dip497/live-scenes", name: "Live scenes", version: "1.0.0", wallpapers: [{ path: "wallpapers/koi" }], startup: { wallpaper: KOI } }),
    "wallpapers/koi/hivemind-wallpaper.json": JSON.stringify({ protocol: 1, name: "Koi Pond", entry: "main.js" }),
    "wallpapers/koi/main.js": fs.readFileSync(dots, "utf8"),
  };
  const dir = path.join(root, "hub", "packages", "live-scenes");
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const index = path.join(root, "hub", "index.json");
  fs.writeFileSync(index, JSON.stringify({ version: 1, plugins: [{
    id: "@dip497/live-scenes", type: "package", name: "Live scenes", description: "Scenes that move behind the canvas.", author: "dip497", version: "1.0.0",
    path: "packages/live-scenes", files: Object.entries(files).map(([f, text]) => ({ path: f, sha256: createHash("sha256").update(text).digest("hex") })),
    members: [{ kind: "wallpaper", id: KOI, name: "Koi Pond", permissions: [] }],
  }] }));
  return pathToFileURL(index).href;
}

test.beforeAll(async () => {
  execFileSync("git", ["init", "-q", path.join(root, "repo")]);
  fs.mkdirSync(path.join(root, "home"));
  // As an app with Koi Pond built in left it.
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ v: 1, appearance: { wallpaper: { kind: "koi", brightness: 0.85, colour: true } } }));
  const env = { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: xdg, HIVEMIND_SHELL_ENV: "0", HIVEMIND_PLUGIN_INDEX: hub() } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [path.resolve("out/main/index.js"), "--no-sandbox"], cwd: path.join(root, "repo"), env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
});
test.afterAll(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const openAppearance = async () => {
  if (await page.locator("[data-settings-body]").count() === 0) await page.locator('[aria-label="settings"]').click();
  await page.locator('[data-settings-page="appearance"]').click();
};

test("Koi Pond chosen before the move: Settings says it comes in Live scenes, and installing that from HiveHub draws it", async () => {
  expect(onDisk().appearance.wallpaper.kind).toBe(KOI);
  await expect(page.locator(".hm-live-frame")).toHaveCount(0);
  await openAppearance();
  const missing = page.locator(`[data-wallpaper-missing="${KOI}"]`);
  await expect(missing).toContainText("Koi Pond comes in Live scenes, which is not installed. The plain background shows until it is.");
  await shot("1-missing");
  await missing.locator('[data-install-start="package:@dip497/live-scenes"]').click();
  await missing.locator("[data-install-confirm]").click();
  await expect(missing).toHaveCount(0);
  await shot("2-installed");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator(`.hm-live-frame[data-drawn][data-wallpaper="${KOI}"]`)).toBeVisible();
  expect(onDisk().appearance.wallpaper.kind).toBe(KOI);
  await shot("3-drawn");
  // HiveHub's list knows it is installed, though it holds only wallpapers.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } })));
  const body = page.locator("[data-settings-body]");
  await body.getByRole("tab", { name: "HiveHub", exact: true }).click();
  await body.locator('[data-plugins-kind="package"]').click();
  const row = body.locator("[data-plugin-row='package:@dip497/live-scenes']");
  await expect(row).toContainText("Installed");
  await expect(body.locator("[data-install-start='package:@dip497/live-scenes']")).toHaveCount(0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
});

test("Make your own in Background hands an agent the prompt for a live wallpaper", async () => {
  await openAppearance();
  await page.locator("summary", { hasText: "Background" }).click();
  await page.locator("[data-make-wallpaper]").click();
  const dialog = page.locator("[data-make-plugin]");
  await expect(dialog.locator('[data-make-kind="wallpaper"]')).toHaveAttribute("aria-checked", "true");
  await dialog.locator("[data-make-idea]").fill("Rain on a window at night");
  await dialog.locator("[data-make-copy]").click();
  await expect(dialog.locator("[data-make-copy]")).toContainText("Copied");
  const prompt = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(prompt).toContain("Build me a Hivemind live wallpaper: Rain on a window at night");
  expect(prompt).toContain("`hive plugins new wallpaper <name>`");
  expect(prompt).toContain("hive config set appearance.wallpaper.kind");
  await shot("4-make-your-own");
});
