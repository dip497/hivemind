// A theme a package holds, in the real app: installed like any package, applied from Settings ▸
// Appearance (its colours, its custom accent on the main button, its font from a woff2 and its
// picture wallpaper, which shows with glass off), reverted in one step, applied again and kept when
// its package is removed, and the same from `hive theme use` / `hive theme revert` while the app runs.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { installPlugin } from "./helpers/install";
import { cssColorToHex } from "@hivemind/core/css-color";

test.use({ trace: "off" });

const APP_DIR = process.cwd();
const CLI = path.resolve(APP_DIR, "../cli/src/index.ts");
const XDG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themes-xdg-"));
const SETTINGS = path.join(XDG, "hivemind", "settings.json");
const MEDIA = path.join(XDG, "hivemind", "media");
/** Where screenshots go for a person to look at, when THEMES_SHOTS names a folder. */
const SHOTS = process.env.THEMES_SHOTS ?? "";

// The fixture package: one dark theme with every kind of file a theme may bring.
const PKG = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themes-pkg-"));
const BG = "#0e1a24";
const BRAND = "#c08552";
const FAMILY = "Harbour Display";
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
const theme = {
  format: 1, name: "Harbour", mode: "dark",
  palette: { bg: BG, bg2: "#14242f", bg3: "#1b2e3b", bg4: "#233847", line: "#233847", line2: "#2f4757", fg: "#eef3f6", fg2: "#c3cfd6", fg3: "#8fa0ab", select: "#c3cfd6", ok: "#7fc49a", warn: "#e6b866", err: "#e08a7a" },
  accent: { brand: BRAND, accent: "#d9a273" },
  fonts: { ui: { family: FAMILY, files: [{ path: "fonts/display.woff2" }] } },
  wallpaper: { image: "still.jpg", brightness: 0.8 },
};
fs.mkdirSync(path.join(PKG, "themes", "harbour", "fonts"), { recursive: true });
fs.copyFileSync(createRequire(path.join(APP_DIR, "package.json")).resolve("katex/dist/fonts/KaTeX_Main-Regular.woff2"), path.join(PKG, "themes", "harbour", "fonts", "display.woff2"));
fs.writeFileSync(path.join(PKG, "themes", "harbour", "still.jpg"), JPEG);
fs.writeFileSync(path.join(PKG, "themes", "harbour", "theme.json"), JSON.stringify(theme));
fs.writeFileSync(path.join(PKG, "hivemind-package.json"), JSON.stringify({ apiVersion: 2, id: "@e2e/looks", name: "Looks", version: "1.0.0", themes: [{ path: "themes/harbour" }] }));
installPlugin(XDG, PKG);

const ENV = { ...process.env, XDG_CONFIG_HOME: XDG, HIVEMIND_SHELL_ENV: "0" } as Record<string, string>;
delete ENV.ELECTRON_RUN_AS_NODE;
delete ENV.HIVE_SETTINGS;
// The CLI finds the running app's drive socket in its data folder (HIVEMIND_APP_DATA, once it runs).
const CLI_ENV: Record<string, string> = { ...ENV, HIVE_DRIVE_SOCK: "", HIVE_HCP_SOCK: "", HCP_TOKEN: "", HIVEMIND_TILE: "" };
const hive = (...args: string[]) => {
  const r = spawnSync("bun", [CLI, ...args, "--json"], { env: CLI_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`hive ${args.join(" ")} → ${r.status}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
};

let app: ElectronApplication;
let page: Page;
const onDisk = () => JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
/** What is painted: the page colour, the interface font, the main button, the wallpaper. */
const painted = () => page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const img = document.querySelector(".hm-wp-image") as HTMLImageElement | null;
  return {
    bg: root.getPropertyValue("--color-bg").trim(),
    font: getComputedStyle(document.body).fontFamily,
    primary: root.getPropertyValue("--primary").trim(),
    wallpaper: img && img.complete && img.naturalWidth > 0 ? decodeURIComponent(img.src) : null,
    glass: document.documentElement.classList.contains("glass-on"),
  };
});
const appearance = async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "appearance" } })));
  await page.locator("[data-themes]").waitFor({ timeout: 10_000 });
};
const closeSettings = () => page.getByRole("button", { name: "Close", exact: true }).click();
let before: Awaited<ReturnType<typeof painted>>;

test.beforeAll(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  app = await electron.launch({ args: [path.join(APP_DIR, "out/main/index.js"), "--no-sandbox"], cwd: PKG, env: ENV });
  page = await app.firstWindow();
  CLI_ENV.HIVEMIND_APP_DATA = await app.evaluate(({ app }) => app.getPath("userData"));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForSelector(".react-flow", { timeout: 30_000 });
  // Glass off: a theme's wallpaper shows without it, and glass stays the person's choice.
  await page.evaluate(() => window.hive.settingsSet("appearance.glass.enabled", false));
  await expect.poll(() => painted().then((p) => p.glass)).toBe(false);
  before = await painted();
});

test.afterAll(async () => {
  await app?.close();
  for (const d of [XDG, PKG]) await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
});

test("applied from Appearance: its colours, its accent on the main button, its font and its wallpaper without glass", async () => {
  await appearance();
  const row = page.locator('[data-theme-option="@e2e/looks/harbour"]');
  await expect(row).toContainText("Harbour");
  await shot("themes-listed");
  await row.getByRole("button", { name: "Apply Harbour" }).click();
  await expect(page.locator('[data-theme-applied="@e2e/looks/harbour"]')).toBeVisible();
  await shot("themes-applied-settings");
  await closeSettings();

  await expect.poll(async () => cssColorToHex((await painted()).bg, "")).toBe(BG);
  const p = await painted();
  expect(p.font).toContain(FAMILY);
  // The face is drawn from the copied woff2, not a fallback.
  await expect.poll(() => page.evaluate((f) => document.fonts.load(`16px "${f}"`).then((faces) => faces.length), FAMILY)).toBe(1);
  expect(cssColorToHex(p.primary, "")).toBe(BRAND);
  await expect.poll(async () => (await painted()).wallpaper).toMatch(/^hivemedia:\/\/media\/theme-[0-9a-f]{8}-still\.jpg$/);
  expect((await painted()).glass).toBe(false);
  expect(onDisk().appearance.glass.enabled).toBe(false);
  // An older build reads the built-in id; the colours are in appearanceExtra.
  expect(onDisk().appearanceExtra).toMatchObject({ accent: theme.accent, theme: { id: "@e2e/looks/harbour", version: "1.0.0" } });
  expect(fs.readdirSync(MEDIA).filter((f) => f.startsWith("theme-")).sort()).toHaveLength(2);
  await shot("themes-applied-canvas");
});

test("Revert to previous look puts back what was there", async () => {
  await appearance();
  await page.locator("[data-theme-revert]").click();
  await expect(page.locator("[data-theme-applied]")).toHaveCount(0);
  await closeSettings();
  await expect.poll(() => painted()).toEqual(before);
  expect(onDisk().appearanceExtra ?? {}).toEqual({});
  // Neither look names the theme's files any more.
  expect(fs.readdirSync(MEDIA).filter((f) => f.startsWith("theme-"))).toEqual([]);
});

test("applied again, its package removed: the look stays, and Appearance says so", async () => {
  await appearance();
  await page.locator('[data-theme-option="@e2e/looks/harbour"]').getByRole("button", { name: "Apply Harbour" }).click();
  await expect(page.locator('[data-theme-applied="@e2e/looks/harbour"]')).toBeVisible();
  await closeSettings();
  await expect.poll(async () => cssColorToHex((await painted()).bg, "")).toBe(BG);

  hive("plugins", "remove", "package:@e2e/looks");
  await appearance();
  await expect(page.locator('[data-theme-applied="@e2e/looks/harbour"]')).toContainText("(its package was removed)");
  await expect(page.locator('[data-theme-option="@e2e/looks/harbour"]')).toHaveCount(0);
  await shot("themes-package-removed");
  await closeSettings();
  expect(cssColorToHex((await painted()).bg, "")).toBe(BG);
  await expect.poll(async () => (await painted()).wallpaper).toMatch(/still\.jpg$/);
});

test("`hive theme use` and `hive theme revert` do the same to the running app", async () => {
  // Back to the start, then install it again from the CLI.
  expect(hive("theme", "revert")).toMatchObject({ rescanned: true });
  await expect.poll(() => painted()).toEqual(before);
  hive("plugins", "install", PKG);
  expect(hive("theme", "use", "@e2e/looks/harbour")).toMatchObject({ theme: "@e2e/looks/harbour", rescanned: true });
  await expect.poll(async () => cssColorToHex((await painted()).bg, "")).toBe(BG);
  expect((await painted()).font).toContain(FAMILY);
  expect(hive("theme", "revert")).toMatchObject({ reverted: "@e2e/looks/harbour", rescanned: true });
  await expect.poll(() => painted()).toEqual(before);
});
