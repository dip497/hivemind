/**
 * Applying, reverting and updating a theme a package holds: the one owner, used by the app
 * (through main) and by `hive theme`. Copy on apply:
 *
 *   1. the files the theme names (fonts, a wallpaper, sounds) are copied into the media folder
 *      beside settings.json, as `theme-<digest8>-<file>`, served as `hivemedia://media/<name>`;
 *   2. `appearance` is written from the theme on top of the look in use: a field the theme leaves
 *      out stays the person's, and glass is always theirs;
 *   3. `appearanceExtra` gets the custom accent, the font faces and the record of what was applied,
 *      with the look before it (`before`, which never holds a theme of its own);
 *   4. media files of themes that neither the look nor `before` names are removed.
 *
 * Revert puts back what the theme set from `before`. Nothing here runs a theme's code: it has none.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { installedMembers } from "./installed-packages.js";
import { lookExtraOf, type AppearanceExtra, type FaceSet, type FontFaces, type ThemeRecord } from "./appearance-extra.js";
import { settingsPath, updateSettings } from "./settings.js";
import { MONO_FONT, UI_FONT, type Appearance, type Settings } from "./settings-schema.js";
import { MOMENTS, themeFiles, themeSwatches, type Theme, type ThemeFace } from "./theme-format.js";
import { readThemeFolder } from "./theme-folder.js";

/** A theme installed here, read from its package's folder. */
export interface InstalledTheme {
  /** `@owner/package/theme`. */
  id: string;
  name: string;
  mode: "dark" | "light";
  /** Five colours to show it by. */
  swatches: string[];
  package: { id: string; name: string; version: string };
  dir: string;
  theme: Theme;
}

/** Every theme the installed packages hold that this build can read. One it cannot is left out,
 *  with why: `hive plugins check` on its package says the same. */
export async function listInstalledThemes(): Promise<{ themes: InstalledTheme[]; problems: { id: string; problem: string }[] }> {
  const themes: InstalledTheme[] = [];
  const problems: { id: string; problem: string }[] = [];
  for (const m of await installedMembers("theme")) {
    try {
      const { id, theme } = await readThemeFolder(m.dir, m.package.id);
      themes.push({ id, name: theme.name, mode: theme.mode, swatches: themeSwatches(theme), package: { id: m.package.id, name: m.package.name, version: m.package.version }, dir: m.dir, theme });
    } catch (e) { problems.push({ id: m.id, problem: e instanceof Error ? e.message : String(e) }); }
  }
  return { themes, problems };
}

/** The media folder: beside settings.json, where the app serves `hivemedia://media/<file>` from. */
export const mediaDirOf = (settingsFile: string): string => path.join(path.dirname(settingsFile), "media");
/** What every file a theme copies is named from. */
const PREFIX = "theme-";
const urlOf = (name: string) => `hivemedia://media/${name}`;

/** Copy the files `theme` names from `dir` into the media folder; their names by path in the theme. */
async function copyFiles(dir: string, theme: Theme, mediaDir: string): Promise<Map<string, string>> {
  const named = [...new Set(themeFiles(theme))].sort();
  const bytes = await Promise.all(named.map((p) => fs.readFile(path.join(dir, p))));
  // One digest for the set: a theme's update gets new names, so the look before it keeps its files.
  const h = createHash("sha256");
  named.forEach((p, i) => h.update(p).update("\0").update(createHash("sha256").update(bytes[i]!).digest("hex")).update("\0"));
  const digest8 = h.digest("hex").slice(0, 8);
  await fs.mkdir(mediaDir, { recursive: true });
  const out = new Map<string, string>();
  for (const [i, p] of named.entries()) {
    const name = `${PREFIX}${digest8}-${p.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "_")}`.slice(0, 160);
    const tmp = path.join(mediaDir, `.${name}.${process.pid}.tmp`);
    await fs.writeFile(tmp, bytes[i]!);
    await fs.rename(tmp, path.join(mediaDir, name));
    out.set(p, urlOf(name));
  }
  return out;
}

/** The fields of `appearance` a theme writes; Revert puts these back and leaves the rest. */
const THEME_FIELDS = ["preset", "mode", "palette", "accent", "terminal", "radius", "uiFont", "monoFont", "wallpaper"] as const satisfies readonly (keyof Appearance)[];

/** Written even where they read the same here: a value this build cannot read (a newer build's
 *  accent id) reads as the default, and a theme's look replaces it. */
const THEME_PATHS = THEME_FIELDS.map((k) => `appearance.${k}`);

const quoted = (family: string) => `"${family}"`;

function facesOf(theme: Theme, urls: Map<string, string>): FontFaces | undefined {
  const set = (f: ThemeFace | undefined): FaceSet | undefined =>
    f ? { family: f.family, files: f.files.map((x) => ({ url: urls.get(x.path)!, ...(x.weight ? { weight: x.weight } : {}), ...(x.style ? { style: x.style } : {}) })) } : undefined;
  const ui = set(theme.fonts?.ui), mono = set(theme.fonts?.mono);
  return ui || mono ? { ...(ui ? { ui } : {}), ...(mono ? { mono } : {}) } : undefined;
}

/** The look with `theme` on top of `cur`: what it sets, the person's own where it says nothing. */
function themedLook(cur: Settings, theme: Theme, urls: Map<string, string>): { appearance: Appearance; extra: AppearanceExtra } {
  const a = cur.appearance;
  const w = theme.wallpaper;
  const wallpaper: Appearance["wallpaper"] = !w ? a.wallpaper
    : "image" in w ? { kind: "image", imageSrc: urls.get(w.image), videoSrc: a.wallpaper.videoSrc, brightness: w.brightness ?? a.wallpaper.brightness }
    : "video" in w ? { kind: "video", videoSrc: urls.get(w.video), imageSrc: a.wallpaper.imageSrc, brightness: w.brightness ?? a.wallpaper.brightness }
    : { ...a.wallpaper, kind: w.kind, brightness: w.brightness ?? a.wallpaper.brightness };
  const fontFaces = facesOf(theme, urls);
  // A custom accent lives in the extra; `appearance.accent` keeps a built-in id an older build reads.
  const custom = typeof theme.accent === "string" ? undefined : theme.accent;
  const { accent: _a, fontFaces: _f, theme: _t, ...others } = cur.appearanceExtra;
  return {
    appearance: {
      ...a,
      preset: "theme",
      mode: theme.mode,
      palette: { ...theme.palette },
      accent: typeof theme.accent === "string" ? theme.accent : a.accent,
      terminal: theme.terminal ? { ...theme.terminal, ansi: [...theme.terminal.ansi] } : a.terminal,
      radius: theme.radius ?? a.radius,
      // The theme's face first, the app's own after it while it loads or for a glyph it lacks.
      uiFont: theme.fonts?.ui ? `${quoted(theme.fonts.ui.family)}, ${UI_FONT}` : a.uiFont,
      monoFont: theme.fonts?.mono ? `${quoted(theme.fonts.mono.family)}, ${MONO_FONT}` : a.monoFont,
      wallpaper,
    },
    extra: {
      ...others,
      ...(custom ? { accent: { ...custom } } : {}),
      ...(fontFaces ? { fontFaces } : !theme.fonts && cur.appearanceExtra.fontFaces ? { fontFaces: cur.appearanceExtra.fontFaces } : {}),
    },
  };
}

/** Every `hivemedia:` address a look names. */
function mediaOf(a: Appearance, extra: AppearanceExtra): string[] {
  return [
    a.wallpaper.imageSrc, a.wallpaper.videoSrc,
    ...[extra.fontFaces?.ui, extra.fontFaces?.mono].flatMap((f) => f?.files.map((x) => x.url) ?? []),
    ...Object.values(extra.theme?.sounds ?? {}),
  ].filter((u): u is string => typeof u === "string");
}

/** Remove the media files themes copied that neither the look in use nor the one before it names. */
async function cleanUp(settingsFile: string, s: Settings): Promise<void> {
  const keep = new Set([...mediaOf(s.appearance, s.appearanceExtra), ...(s.appearanceExtra.theme ? mediaOf(s.appearanceExtra.theme.before.appearance, s.appearanceExtra.theme.before.extra) : [])]);
  const dir = mediaDirOf(settingsFile);
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n.startsWith(PREFIX) && !keep.has(urlOf(n))).map((n) => fs.rm(path.join(dir, n), { force: true })));
}

/** Apply an installed theme over the look in use. Returns the settings as written. */
export async function applyTheme(t: InstalledTheme, settingsFile: string = settingsPath()): Promise<Settings> {
  const urls = await copyFiles(t.dir, t.theme, mediaDirOf(settingsFile));
  const sounds = Object.fromEntries(MOMENTS.flatMap((m) => (t.theme.sounds?.[m] ? [[m, urls.get(t.theme.sounds[m]!)!]] : [])));
  const written = await updateSettings((cur) => {
    const was = cur.appearanceExtra.theme;
    // Applying the same theme again (an update) keeps the look from before it, so Revert still
    // leaves the theme; another theme's look is the one to go back to, without its record.
    const before = was && was.id === t.id ? was.before : { appearance: cur.appearance, extra: lookExtraOf(cur.appearanceExtra) };
    const look = themedLook(cur, t.theme, urls);
    const record: ThemeRecord = {
      id: t.id, name: t.name, version: t.package.version, appliedAt: Date.now(), before,
      ...(Object.keys(sounds).length ? { sounds } : {}),
    };
    return { ...cur, appearance: look.appearance, appearanceExtra: { ...look.extra, theme: record } };
  }, settingsFile, THEME_PATHS);
  await cleanUp(settingsFile, written);
  return written;
}

/** Go back to the look before the theme: what the theme set, from `before`; glass, overlays and
 *  whatever else the person set since stay as they are. Throws when no theme is applied. */
export async function revertTheme(settingsFile: string = settingsPath()): Promise<Settings> {
  let had = true;
  const written = await updateSettings((cur) => {
    const record = cur.appearanceExtra.theme;
    if (!record) { had = false; return cur; }
    const { accent: _a, fontFaces: _f, theme: _t, ...others } = cur.appearanceExtra;
    const back = Object.fromEntries(THEME_FIELDS.map((k) => [k, record.before.appearance[k]]));
    return { ...cur, appearance: { ...cur.appearance, ...back }, appearanceExtra: { ...others, ...record.before.extra } };
  }, settingsFile, THEME_PATHS);
  if (!had) throw new Error("no theme is applied: there is no look to go back to");
  await cleanUp(settingsFile, written);
  return written;
}

/** What the applied theme's record says against what is installed now: a newer version to apply,
 *  or that its package is gone (the look stays). */
export function themeStatus(record: ThemeRecord | undefined, installed: readonly Pick<InstalledTheme, "id" | "package">[]): { update: string | null; removed: boolean } | null {
  if (!record) return null;
  const now = installed.find((x) => x.id === record.id);
  if (!now) return { update: null, removed: true };
  return { update: now.package.version !== record.version ? now.package.version : null, removed: false };
}
