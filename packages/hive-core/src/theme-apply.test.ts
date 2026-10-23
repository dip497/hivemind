// Applying a theme copies its files beside settings.json and writes the look; Revert is one step
// back; the media folder keeps the files of the look in use and the one before it, no more.
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installPackage, removePackage } from "./package-install.js";
import { readSettings, updateSettings } from "./settings.js";
import { DEFAULT_APPEARANCE, UI_FONT } from "./settings-schema.js";
import { applyTheme, listInstalledThemes, mediaDirOf, revertTheme, themeStatus } from "./theme-apply.js";

let tmp: string;
let settings: string;
const saved = { xdg: process.env.XDG_CONFIG_HOME, settings: process.env.HIVE_SETTINGS };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-themes-"));
  process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
  settings = path.join(tmp, "config", "hivemind", "settings.json");
  process.env.HIVE_SETTINGS = settings;
});
afterEach(() => {
  for (const [k, v] of [["XDG_CONFIG_HOME", saved.xdg], ["HIVE_SETTINGS", saved.settings]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PALETTE = (bg: string) => ({ bg, bg2: "#14242f", bg3: "#1b2e3b", bg4: "#233847", line: "#233847", line2: "#2f4757", fg: "#eef3f6", fg2: "#c3cfd6", fg3: "#8fa0ab", select: "#c3cfd6", ok: "#7fc49a", warn: "#e6b866", err: "#e08a7a" });
const WOOD = { brand: "#b07a4f", accent: "#c99a72" };

/** A package `@acme/looks` at `version` holding the themes given as folder → theme.json, each
 *  with a font, a picture and a sound whose bytes carry `stamp`. */
function looks(version: string, themes: Record<string, Record<string, unknown>>, stamp = version): string {
  const root = path.join(tmp, `looks-${version}-${Object.keys(themes).join("-")}`);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, theme] of Object.entries(themes)) {
    const dir = path.join(root, "themes", name);
    fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "fonts", "display.woff2"), `font ${name} ${stamp}`);
    fs.writeFileSync(path.join(dir, "still.webp"), `image ${name} ${stamp}`);
    fs.writeFileSync(path.join(dir, "needs.ogg"), `sound ${name} ${stamp}`);
    fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify(theme));
  }
  fs.writeFileSync(path.join(root, "hivemind-package.json"), JSON.stringify({ apiVersion: 2, id: "@acme/looks", name: "Looks", version, themes: Object.keys(themes).map((t) => ({ path: `themes/${t}` })) }));
  return root;
}
const FULL = (name: string, bg: string) => ({
  format: 1, name, mode: "dark", palette: PALETTE(bg), accent: WOOD,
  fonts: { ui: { family: `${name} Display`, files: [{ path: "fonts/display.woff2" }] } },
  wallpaper: { image: "still.webp", brightness: 0.7 },
  sounds: { needs: "needs.ogg" },
});
const PARTIAL = (name: string, bg: string) => ({ format: 1, name, mode: "dark", palette: PALETTE(bg), accent: "ice" });

async function installed(id: string) {
  const t = (await listInstalledThemes()).themes.find((x) => x.id === id);
  if (!t) throw new Error(`${id} is not installed`);
  return t;
}
const mediaFiles = () => { try { return fs.readdirSync(mediaDirOf(settings)).sort(); } catch { return []; } };
const fileOf = (url: string | undefined) => path.join(mediaDirOf(settings), url!.replace("hivemedia://media/", ""));

test("applying a theme writes its look over the person's and copies its files beside settings.json", async () => {
  await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, accent: "ember", radius: 6, glass: { ...s.appearance.glass, enabled: false } } }));
  await installPackage(looks("1.0.0", { harbour: FULL("Harbour", "#0e1a24") }));
  const s = await applyTheme(await installed("@acme/looks/harbour"));

  expect(s.appearance).toMatchObject({ mode: "dark", palette: PALETTE("#0e1a24"), radius: 6, uiFont: `"Harbour Display", ${UI_FONT}` });
  // The custom accent is in the extra; the built-in id an older build reads is left as it was.
  expect(s.appearance.accent).toBe("ember");
  expect(s.appearanceExtra.accent).toEqual(WOOD);
  // Glass stays the person's.
  expect(s.appearance.glass.enabled).toBe(false);
  expect(s.appearance.wallpaper).toMatchObject({ kind: "image", brightness: 0.7 });
  expect(fs.readFileSync(fileOf(s.appearance.wallpaper.imageSrc), "utf8")).toBe("image harbour 1.0.0");
  expect(fs.readFileSync(fileOf(s.appearanceExtra.fontFaces?.ui?.files[0]?.url), "utf8")).toBe("font harbour 1.0.0");
  expect(fs.readFileSync(fileOf(s.appearanceExtra.theme?.sounds?.needs), "utf8")).toBe("sound harbour 1.0.0");
  expect(mediaFiles().every((f) => /^theme-[0-9a-f]{8}-/.test(f))).toBe(true);
  expect(s.appearanceExtra.theme).toMatchObject({ id: "@acme/looks/harbour", name: "Harbour", version: "1.0.0" });
  // What is on disk is what was returned.
  expect((await readSettings()).appearanceExtra).toEqual(s.appearanceExtra);
});

test("a theme that leaves fields out keeps the person's; Revert puts back what it set and keeps what was changed since", async () => {
  await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, radius: 3, uiFont: "Inter, sans-serif" }, appearanceExtra: { accent: WOOD } }));
  const before = await readSettings();
  await installPackage(looks("1.0.0", { plain: PARTIAL("Plain", "#101820") }));
  const s = await applyTheme(await installed("@acme/looks/plain"));
  expect(s.appearance).toMatchObject({ radius: 3, uiFont: "Inter, sans-serif", accent: "ice", wallpaper: before.appearance.wallpaper, terminal: before.appearance.terminal });
  expect(s.appearanceExtra.accent).toBeUndefined();

  await updateSettings((cur) => ({ ...cur, appearance: { ...cur.appearance, glass: { ...cur.appearance.glass, blur: 9 } } }));
  const back = await revertTheme();
  expect(back.appearance.palette).toEqual(before.appearance.palette);
  expect(back.appearance.preset).toBe(before.appearance.preset);
  expect(back.appearanceExtra).toEqual({ accent: WOOD });
  expect(back.appearance.glass.blur).toBe(9);
  await expect(revertTheme()).rejects.toThrow(/no theme is applied/);
});

test("`before` never nests: a second theme goes back to the first theme's look, without its record", async () => {
  await installPackage(looks("1.0.0", { a: FULL("Ay", "#0e1a24"), b: PARTIAL("Bee", "#101820") }));
  const a = await applyTheme(await installed("@acme/looks/a"));
  const b = await applyTheme(await installed("@acme/looks/b"));
  expect(b.appearanceExtra.theme?.before.appearance.palette).toEqual(a.appearance.palette);
  expect(b.appearanceExtra.theme?.before.extra).not.toHaveProperty("theme");
  expect(JSON.stringify(b.appearanceExtra.theme?.before)).not.toContain("@acme/looks/a");
  const back = await revertTheme();
  expect(back.appearance.palette).toEqual(a.appearance.palette);
  expect(back.appearanceExtra.theme).toBeUndefined();
});

test("the media folder keeps exactly the files of the look in use and the one before it", async () => {
  await installPackage(looks("1.0.0", { a: FULL("Ay", "#0e1a24"), b: FULL("Bee", "#101820"), c: PARTIAL("Sea", "#0b1520") }));
  const a = await applyTheme(await installed("@acme/looks/a"));
  const aFiles = mediaFiles();
  expect(aFiles).toHaveLength(3);
  const b = await applyTheme(await installed("@acme/looks/b"));
  // B's three, and A's picture and font, which the look before B shows; A's sound went with A's record.
  expect(mediaFiles()).toHaveLength(5);
  expect(fs.existsSync(fileOf(a.appearanceExtra.theme?.sounds?.needs))).toBe(false);
  // C sets no files: in use are B's (its wallpaper and fonts stay), before it B's too; A's go.
  await applyTheme(await installed("@acme/looks/c"));
  expect(mediaFiles().filter((f) => aFiles.includes(f))).toEqual([]);
  expect(fs.existsSync(fileOf(b.appearance.wallpaper.imageSrc))).toBe(true);
  // B's sound went with B's record.
  expect(fs.existsSync(fileOf(b.appearanceExtra.theme?.sounds?.needs))).toBe(false);
});

test("an update shows as one, applying it keeps the look from before the theme, and a removed package leaves the look", async () => {
  await installPackage(looks("1.0.0", { harbour: FULL("Harbour", "#0e1a24") }));
  await applyTheme(await installed("@acme/looks/harbour"));
  await installPackage(looks("1.1.0", { harbour: FULL("Harbour", "#0f1b25") }));
  const { themes } = await listInstalledThemes();
  expect(themeStatus((await readSettings()).appearanceExtra.theme, themes)).toEqual({ update: "1.1.0", removed: false });

  const s = await applyTheme(await installed("@acme/looks/harbour"));
  expect(s.appearanceExtra.theme?.version).toBe("1.1.0");
  expect(s.appearanceExtra.theme?.before.appearance.palette).toEqual(DEFAULT_APPEARANCE.palette);
  expect(themeStatus(s.appearanceExtra.theme, (await listInstalledThemes()).themes)).toEqual({ update: null, removed: false });

  await removePackage("@acme/looks");
  const after = await readSettings();
  expect(after.appearance.palette.bg).toBe("#0f1b25");
  expect(themeStatus(after.appearanceExtra.theme, (await listInstalledThemes()).themes)).toEqual({ update: null, removed: true });
  expect(fs.existsSync(fileOf(after.appearance.wallpaper.imageSrc))).toBe(true);
});
