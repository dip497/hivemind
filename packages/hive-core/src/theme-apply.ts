/**
 * Applying, reverting and updating a theme a package holds: the one owner, used by the app
 * (through main) and by `hive theme`. Copy on apply:
 *
 *   1. the files the theme names (fonts, a wallpaper, sounds) are copied into the media folder
 *      beside settings.json, as `theme-<digest8>-<file>`, served as `hivemedia://media/<name>`;
 *   2. the parts of the look the theme names are written (`themeSetPaths`): the colours and accent
 *      always, corners, terminal, fonts and wallpaper only when it has them; the rest stays the
 *      person's, and glass is always theirs;
 *   3. `appearanceExtra.theme` is replaced by the record of what was applied: which parts it set,
 *      and the look before it (`before`, which never holds a theme of its own);
 *   4. media files of themes that neither the look nor `before` names are removed.
 *
 * Revert puts back the parts the theme set from `before`, and nothing else. One apply or revert
 * runs at a time, across processes (the media lock). Nothing here runs a theme's code: it has none.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { installedMembers } from "./installed-packages.js";
import { lookExtraOf, THEME_SET_PATHS, type AppearanceExtra, type FaceSet, type FontFaces, type LookExtra, type ThemeRecord, type ThemeSetPath } from "./appearance-extra.js";
import { holdLock, readSettings, settingsPath, updateSettings } from "./settings.js";
import { faceStack } from "./font-names.js";
import type { Appearance, Settings } from "./settings-schema.js";
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

/** The parts of the look `theme` sets (`THEME_SET_PATHS`): the colours and the accent always,
 *  the rest only when it names them. Revert puts back these and nothing else. */
export function themeSetPaths(theme: Theme): ThemeSetPath[] {
  const named: Record<ThemeSetPath, boolean> = {
    "appearance.preset": true, "appearance.mode": true, "appearance.palette": true,
    "appearance.accent": true, "appearanceExtra.accent": true,
    "appearance.terminal": !!theme.terminal, "appearance.radius": theme.radius !== undefined, "appearance.wallpaper": !!theme.wallpaper,
    "appearance.uiFont": !!theme.fonts?.ui, "appearanceExtra.fontFaces.ui": !!theme.fonts?.ui,
    "appearance.monoFont": !!theme.fonts?.mono, "appearanceExtra.fontFaces.mono": !!theme.fonts?.mono,
  };
  return THEME_SET_PATHS.filter((p) => named[p]);
}

function faceSet(f: ThemeFace, urls: Map<string, string>): FaceSet {
  return { family: f.family, files: f.files.map((x) => ({ url: urls.get(x.path)!, ...(x.weight ? { weight: x.weight } : {}), ...(x.style ? { style: x.style } : {}) })) };
}

/** The look with `theme` on top of `cur`: what it names, the person's own where it says nothing. */
function themedLook(cur: Settings, theme: Theme, urls: Map<string, string>): { appearance: Appearance; extra: LookExtra } {
  const a = cur.appearance;
  const w = theme.wallpaper;
  const wallpaper: Appearance["wallpaper"] = !w ? a.wallpaper
    : "image" in w ? { kind: "image", imageSrc: urls.get(w.image), videoSrc: a.wallpaper.videoSrc, brightness: w.brightness ?? a.wallpaper.brightness }
    : "video" in w ? { kind: "video", videoSrc: urls.get(w.video), imageSrc: a.wallpaper.imageSrc, brightness: w.brightness ?? a.wallpaper.brightness }
    : { ...a.wallpaper, kind: w.kind, brightness: w.brightness ?? a.wallpaper.brightness };
  const { ui, mono } = theme.fonts ?? {};
  const fontFaces: FontFaces = { ...(ui ? { ui: faceSet(ui, urls) } : {}), ...(mono ? { mono: faceSet(mono, urls) } : {}) };
  // A custom accent lives in the extra; `appearance.accent` keeps a built-in id an older build reads.
  const custom = typeof theme.accent === "string" ? undefined : theme.accent;
  return {
    appearance: {
      ...a,
      preset: "theme",
      mode: theme.mode,
      palette: { ...theme.palette },
      accent: typeof theme.accent === "string" ? theme.accent : a.accent,
      terminal: theme.terminal ? { ...theme.terminal, ansi: [...theme.terminal.ansi] } : a.terminal,
      radius: theme.radius ?? a.radius,
      uiFont: ui ? faceStack("ui", ui.family) : a.uiFont,
      monoFont: mono ? faceStack("mono", mono.family) : a.monoFont,
      wallpaper,
    },
    extra: {
      ...(custom ? { accent: { ...custom } } : {}),
      ...(fontFaces.ui || fontFaces.mono ? { fontFaces } : {}),
    },
  };
}

/** `look`'s value at each of `paths` written over `cur`: what applying sets and Revert puts back.
 *  Faces go one by one, so a theme with a UI font keeps the code font's face in use. */
function withParts(cur: Settings, look: { appearance: Appearance; extra: LookExtra }, paths: readonly ThemeSetPath[]): Settings {
  const appearance: Record<string, unknown> = { ...cur.appearance };
  const extra: AppearanceExtra = { ...cur.appearanceExtra };
  const faces: FontFaces = { ...extra.fontFaces };
  for (const p of paths) {
    const [top, key, face] = p.split(".") as ["appearance" | "appearanceExtra", string, "ui" | "mono" | undefined];
    if (top === "appearance") appearance[key] = look.appearance[key as keyof Appearance];
    else if (key === "accent") { if (look.extra.accent) extra.accent = look.extra.accent; else delete extra.accent; }
    else if (face) { const f = look.extra.fontFaces?.[face]; if (f) faces[face] = f; else delete faces[face]; }
  }
  if (faces.ui || faces.mono) extra.fontFaces = faces; else delete extra.fontFaces;
  return { ...cur, appearance: appearance as unknown as Appearance, appearanceExtra: extra };
}

/** Every `hivemedia:` address a look names. */
function mediaOf(a: Appearance, extra: AppearanceExtra): string[] {
  return [
    a.wallpaper.imageSrc, a.wallpaper.videoSrc,
    ...[extra.fontFaces?.ui, extra.fontFaces?.mono].flatMap((f) => f?.files.map((x) => x.url) ?? []),
    ...Object.values(extra.theme?.sounds ?? {}),
  ].filter((u): u is string => typeof u === "string");
}

/** Remove the media files themes copied that neither the look on disk now nor the one before it
 *  names. Read again here, under the media lock: the settings a write returned may be older. */
async function cleanUp(settingsFile: string): Promise<void> {
  const s = await readSettings(settingsFile);
  const keep = new Set([...mediaOf(s.appearance, s.appearanceExtra), ...(s.appearanceExtra.theme ? mediaOf(s.appearanceExtra.theme.before.appearance, s.appearanceExtra.theme.before.extra) : [])]);
  const dir = mediaDirOf(settingsFile);
  let names: string[] = [];
  try { names = await fs.readdir(dir); } catch { return; }
  await Promise.all(names.filter((n) => n.startsWith(PREFIX) && !keep.has(urlOf(n))).map((n) => fs.rm(path.join(dir, n), { force: true })));
}

/** How long one apply or revert waits for another's copy and cleanup (a theme's video is large). */
const MEDIA_WAIT_MS = 60_000;
/** One apply or revert at a time, across processes: copying, the settings write and cleanup, so
 *  one never removes the files of the theme another has just applied. A lock file of its own, not
 *  settings.json's: the write inside takes that one, and nesting it would wait on itself. */
const underMediaLock = <T>(settingsFile: string, work: () => Promise<T>): Promise<T> =>
  holdLock(path.join(mediaDirOf(settingsFile), ".lock"), work, MEDIA_WAIT_MS);

/** Apply an installed theme over the look in use. Returns the settings as written. */
export function applyTheme(t: InstalledTheme, settingsFile: string = settingsPath()): Promise<Settings> {
  return underMediaLock(settingsFile, async () => {
    const urls = await copyFiles(t.dir, t.theme, mediaDirOf(settingsFile));
    const sounds = Object.fromEntries(MOMENTS.flatMap((m) => (t.theme.sounds?.[m] ? [[m, urls.get(t.theme.sounds[m]!)!]] : [])));
    const paths = themeSetPaths(t.theme);
    const written = await updateSettings((cur) => {
      const was = cur.appearanceExtra.theme;
      // Applying the same theme again (an update) keeps the look from before it, and what either
      // version set, so Revert still leaves the theme; another theme's look is the one to go back
      // to, without its record.
      const again = was && was.id === t.id;
      const before = again ? was.before : { appearance: cur.appearance, extra: lookExtraOf(cur.appearanceExtra) };
      const set = again ? THEME_SET_PATHS.filter((p) => paths.includes(p) || was.set.includes(p)) : paths;
      const next = withParts(cur, themedLook(cur, t.theme, urls), paths);
      const record: ThemeRecord = {
        id: t.id, name: t.name, version: t.package.version, appliedAt: Date.now(), before, set: [...set],
        ...(Object.keys(sounds).length ? { sounds } : {}),
      };
      return { ...next, appearanceExtra: { ...next.appearanceExtra, theme: record } };
    }, settingsFile, [...paths, { replace: "appearanceExtra.theme" }]);
    await cleanUp(settingsFile);
    return written;
  });
}

/** Go back to the look before the theme: each part the theme set (its record's `set`), from
 *  `before`; glass, overlays and whatever else the person set since stay as they are. Throws when
 *  no theme is applied. */
export function revertTheme(settingsFile: string = settingsPath()): Promise<Settings> {
  return underMediaLock(settingsFile, async () => {
    const record = (await readSettings(settingsFile)).appearanceExtra.theme;
    if (!record) throw new Error("no theme is applied: there is no look to go back to");
    // Another apply or revert waits on the media lock; a preset chosen meanwhile drops the record,
    // and then there is nothing to go back to.
    const written = await updateSettings((cur) => {
      if (cur.appearanceExtra.theme?.id !== record.id) return cur;
      const back = withParts(cur, record.before, record.set);
      const { theme: _t, ...extra } = back.appearanceExtra;
      return { ...back, appearanceExtra: extra };
    }, settingsFile, [...record.set, "appearanceExtra.theme"]);
    await cleanUp(settingsFile);
    return written;
  });
}

/** What the applied theme's record says against what is installed now: a newer version to apply,
 *  or that its package is gone (the look stays). */
export function themeStatus(record: ThemeRecord | undefined, installed: readonly Pick<InstalledTheme, "id" | "package">[]): { update: string | null; removed: boolean } | null {
  if (!record) return null;
  const now = installed.find((x) => x.id === record.id);
  if (!now) return { update: null, removed: true };
  return { update: now.package.version !== record.version ? now.package.version : null, removed: false };
}
