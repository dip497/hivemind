/**
 * The theme member: what a package's `themes/<name>/theme.json` may say, checked without a file
 * system or a DOM, so the app, `hive plugins check` and HiveHub refuse the same themes for the
 * same reasons. A theme is data: it carries no code, and its files (fonts, a wallpaper, sounds)
 * are typed and sized here and copied into the media folder when it is applied
 * (`./theme-apply.ts`).
 *
 * `format: 1` holds a look's colours, accent, terminal, corners, fonts, wallpaper and sounds. The
 * other parts of a look are reserved by name for a later format (customization-gaps review §5):
 * a theme naming one is refused here, so an author learns it does nothing yet.
 */
import { contrastRatio, cssColorToHex, cssColorToOklab, cssColorToRgb, parseCssColor } from "./css-color.js";
import { diffContrastProblem } from "./diff-colours.js";
import { FAMILY_RE, MAX_FACE_FILES, STYLE_RE, WEIGHT_RE, accentOf, isThemeColor, type AccentColors, type AppearanceExtra } from "./appearance-extra.js";
import { ACCENTS, PALETTE_KEYS, WALLPAPERS, type AccentId, type Appearance, type Palette, type TerminalPalette, type WallpaperId } from "./settings-schema.js";

/** The file that makes a folder a theme. */
export const THEME_MANIFEST = "theme.json";
/** The format this build reads. */
export const THEME_FORMAT = 1;
/** Parts of a look a later format fills (review §5). Named now so a theme cannot use them for
 *  something else. */
export const RESERVED_THEME_PARTS = ["icons", "cursors", "scene", "mascot", "screens", "words"] as const;

/** The most a theme's files may weigh, each. A picture or a video is held to HiveHub's cap on any
 *  one file of a plugin (`MAX_PLUGIN_FILE_BYTES`, 2 MB; a whole package at most 8 MB), so a theme
 *  that passes here is one HiveHub lists. */
export const THEME_FILE_LIMITS = { font: 400 * 1024, sound: 400 * 1024, image: 2 * 1024 * 1024, video: 2 * 1024 * 1024 } as const;
/** A theme's folder name, which is the last part of its id. */
export const THEME_FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** How many folders deep a theme's files may sit (`fonts/x.woff2` is one): the app reads its
 *  folder no deeper, so a path deeper is refused rather than missed. */
export const THEME_DEPTH = 4;
const SOUND_EXT = /\.(ogg|mp3)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|gif)$/i;
const VIDEO_EXT = /\.(webm|mp4)$/i;
/** Text a person reads: no control characters, nothing that reorders what is read. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

/** Contrast the app's text needs, checked on every theme: text on the page and on panels, and
 *  the quieter second text on the page. */
export const CONTRAST_PAIRS = [
  { fg: "fg", bg: "bg", least: 4.5 },
  { fg: "fg", bg: "bg2", least: 4.5 },
  { fg: "fg2", bg: "bg", least: 3 },
] as const satisfies readonly { fg: keyof Palette; bg: keyof Palette; least: number }[];
/** An accent is a mark: 3:1 against every surface it is drawn on. */
export const ACCENT_CONTRAST = 3;
/** Where the accent is drawn as a mark (apps/desktop styles.css): on the page (`bg`: the canvas,
 *  Settings), and on the panels and menus (`bg2`: the Layers panel, a popover's switch that is on).
 *  A slider's thumb is ringed in `bg2` wherever it sits, and so is the selected tile's handle over a
 *  picture, so `bg2` is under them too. */
export const ACCENT_SURFACES = ["bg", "bg2"] as const satisfies readonly (keyof Palette)[];
/** How close in OKLab an accent may come to the colour of "needs you" (`warn`). */
const WARN_DISTANCE = 0.05;

export const MOMENTS = ["needs", "done", "error"] as const;
export type Moment = (typeof MOMENTS)[number];

export interface ThemeFontFile { path: string; weight?: string; style?: string }
export interface ThemeFace { family: string; files: ThemeFontFile[] }
/** A built-in wallpaper a theme may name. Not Shoal yet: an app without it refuses the whole theme. */
type ThemeWallpaperKind = Exclude<WallpaperId, "image" | "video" | "shoal">;
export type ThemeWallpaper =
  | { kind: ThemeWallpaperKind; brightness?: number }
  | { image: string; brightness?: number }
  | { video: string; brightness?: number };

/** A `theme.json`, checked. */
export interface Theme {
  format: 1;
  name: string;
  mode: "dark" | "light";
  palette: Palette;
  accent: AccentId | AccentColors;
  terminal?: TerminalPalette;
  radius?: number;
  fonts?: { ui?: ThemeFace; mono?: ThemeFace };
  wallpaper?: ThemeWallpaper;
  sounds?: Partial<Record<Moment, string>>;
}

/** A file in the theme's folder: its path inside it and its size. */
export interface ThemeFolderFile { path: string; bytes: number }

const FIELDS = new Set(["$schema", "format", "name", "mode", "palette", "accent", "terminal", "radius", "fonts", "wallpaper", "sounds"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

/** A colour a theme may use, without transparency: its contrast is what is drawn. */
function opaque(v: unknown, field: string): string {
  if (!isThemeColor(v)) return refuse(`${field} is not a colour this app reads: write it as #rrggbb, rgb() or oklch()`);
  if (parseCssColor(v)!.alpha) refuse(`${field} has transparency; a theme's ${field.split(".")[0]} colours are solid`);
  return v.trim();
}

const fixed = (n: number) => (Math.floor(n * 100) / 100).toFixed(2);

/** Check the contrast pairs of a palette: null when they hold, else the first that does not, in words. */
export function contrastProblem(palette: Palette): string | null {
  for (const p of CONTRAST_PAIRS) {
    const r = contrastRatio(palette[p.fg], palette[p.bg]);
    if (r === null) return `${p.fg} or ${p.bg} cannot be read as a colour`;
    if (r < p.least) return `${p.fg} on ${p.bg} is ${fixed(r)}:1; it needs at least ${p.least}:1 to be read`;
  }
  return null;
}

function fileIn(files: readonly ThemeFolderFile[], at: unknown, field: string, ext: RegExp, kind: string, limit: number): string {
  if (typeof at !== "string" || !at || at.startsWith("/") || at.split("/").some((x) => x === ".." || x === "." || x === "") || /[\\\u0000-\u001f]/.test(at)) {
    return refuse(`${field} is not a path inside the theme's folder`);
  }
  if (at.split("/").length > THEME_DEPTH + 1) refuse(`${field}: ${at} is more than ${THEME_DEPTH} folders deep in the theme's folder`);
  if (!ext.test(at)) refuse(`${field}: ${at} is not ${kind}`);
  const f = files.find((x) => x.path === at) ?? refuse(`${field}: there is no ${at} in the theme's folder`);
  if (f.bytes > limit) refuse(`${field}: ${at} is ${Math.ceil(f.bytes / 1024)} KB; ${kind.replace(/^an? /, "")} may be at most ${Math.round(limit / 1024)} KB`);
  return at;
}

function faceOf(v: unknown, field: string, files: readonly ThemeFolderFile[]): ThemeFace {
  if (!isObj(v)) return refuse(`${field} is { family, files }`);
  if (typeof v.family !== "string" || !FAMILY_RE.test(v.family)) refuse(`${field}.family is a font's name: letters, digits, spaces and dashes, up to 60`);
  if (!Array.isArray(v.files) || !v.files.length || v.files.length > MAX_FACE_FILES) return refuse(`${field}.files lists 1 to ${MAX_FACE_FILES} font files`);
  return {
    family: v.family as string,
    files: v.files.map((f, i) => {
      const at = `${field}.files.${i}`;
      if (!isObj(f)) return refuse(`${at} is { path, weight?, style? }`);
      if (f.weight !== undefined && (typeof f.weight !== "string" || !WEIGHT_RE.test(f.weight))) refuse(`${at}.weight is like "400", "300 700" or "bold"`);
      if (f.style !== undefined && (typeof f.style !== "string" || !STYLE_RE.test(f.style))) refuse(`${at}.style is normal, italic or oblique`);
      return { path: fileIn(files, f.path, `${at}.path`, /\.woff2$/i, "a .woff2 font", THEME_FILE_LIMITS.font), ...(f.weight ? { weight: f.weight as string } : {}), ...(f.style ? { style: f.style as string } : {}) };
    }),
  };
}

function accentOfTheme(v: unknown, palette: Palette): AccentId | AccentColors {
  let colours: AccentColors;
  if (typeof v === "string") {
    if (!(v in ACCENTS)) return refuse(`accent is one of ${Object.keys(ACCENTS).join(", ")}, or { brand, accent, working? } colours`);
    if (v === "amber") refuse("accent: amber is the colour of an agent waiting on you; a theme's accent is another colour");
    colours = ACCENTS[v as AccentId];
  } else {
    if (!isObj(v)) return refuse("accent is one of the built-in ids, or { brand, accent, working? } colours");
    colours = { brand: opaque(v.brand, "accent.brand"), accent: opaque(v.accent, "accent.accent"), ...(v.working !== undefined ? { working: opaque(v.working, "accent.working") } : {}) };
  }
  // The accent is the person's, never a signal (apps/desktop/DESIGN.md): not the colour of "needs you".
  // Needs-you is drawn in the palette's warn fitted to it (`statusInk`, `statusTextInk`), which can
  // sit well away from warn itself, so the accent is kept from all three.
  const needs = [palette.warn, statusInk(palette.warn, palette), statusTextInk(palette.warn, palette)].map(cssColorToOklab);
  for (const k of ["brand", "accent"] as const) {
    const c = cssColorToOklab(colours[k]);
    if (c && needs.some((w) => w && Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2]) < WARN_DISTANCE)) {
      refuse(`accent.${k} is the colour of an agent waiting on you (palette.warn, as needs-you is drawn); a theme's accent is another colour`);
    }
  }
  const mark = accentMark(colours.brand, palette);
  if (mark && mark.ratio < ACCENT_CONTRAST) refuse(`accent.brand on ${mark.on} is ${fixed(mark.ratio)}:1; a switch that is on or a slider's thumb in it needs at least ${ACCENT_CONTRAST}:1`);
  return typeof v === "string" ? (v as AccentId) : colours;
}

/** How an accent's `brand` reads as a mark: its lowest contrast with a surface it is drawn on
 *  (`ACCENT_SURFACES`), and which surface that is; null when a colour cannot be read. The theme
 *  check refuses below `ACCENT_CONTRAST`, and Settings ▸ Appearance says so of a colour the person
 *  picks. */
export function accentMark(brand: string, palette: Pick<Palette, (typeof ACCENT_SURFACES)[number]>): { on: (typeof ACCENT_SURFACES)[number]; ratio: number } | null {
  let low: { on: (typeof ACCENT_SURFACES)[number]; ratio: number } | null = null;
  for (const on of ACCENT_SURFACES) {
    const ratio = contrastRatio(brand, palette[on]);
    if (ratio === null) return null;
    if (!low || ratio < low.ratio) low = { on, ratio };
  }
  return low;
}

/** What a status mark is drawn on in a list (Layers, Home, the slot bar): a row at rest, under the
 *  pointer and selected (graphite-sheet, -card and -hover in apps/desktop/DESIGN.md), and a tile's
 *  header (graphite-card). Rows and headers paint the solid surface, glass on or off. */
export const STATUS_SURFACES = ["bg2", "bg3", "bg4"] as const satisfies readonly (keyof Palette)[];
/** Unread and finished-since-you-looked: a clear blue whatever the accent (apps/desktop styles.css
 *  `--color-unread`, DESIGN.md Unread Blue), before `statusInk` fits it to a palette. */
export const UNREAD_BLUE = "oklch(0.70 0.14 250)";
/** A status chip's fill: its colour at this share over the panel colour (`color-mix(in srgb,
 *  <status> 16%, var(--surface-2))`), opaque, so its word reads the same on any row under it. */
export const CHIP_TINT = 0.16;
/** A word on its chip or on a surface, and a mark on a surface. */
export const STATUS_CONTRAST = { word: 4.5, mark: 3 } as const;
/** Where the accent is drawn as a small mark beyond `ACCENT_SURFACES`: a pin, a check or a frame's
 *  server icon on a tile's header, a toast's icon on its card (`bg3`). */
export const ACCENT_MARK_SURFACES = ["bg", "bg2", "bg3"] as const satisfies readonly (keyof Palette)[];

/** `color` over `surface` at `share`, as `color-mix(in srgb, …)` paints it; null when unreadable. */
function tint(color: string, share: number, surface: string): string | null {
  const c = cssColorToRgb(color), s = cssColorToRgb(surface);
  return c && s ? cssColorToHex(`rgb(${c.map((x, i) => x * share + s[i]! * (1 - share)).join(" ")})`, "") : null;
}

const atLeast = (a: string, b: string | null, least: number) => b !== null && (contrastRatio(a, b) ?? 0) >= least;
/** A status's mark reads at 3:1 on every surface in `STATUS_SURFACES`. */
const marksRead = (c: string, p: Pick<Palette, (typeof STATUS_SURFACES)[number]>) =>
  STATUS_SURFACES.every((on) => atLeast(c, p[on], STATUS_CONTRAST.mark));

/** `color` itself when `reads` holds for it, else the nearest colour of its hue that does, moved in
 *  lightness away from the surfaces (lighter on a dark palette, darker on a light one) with as much
 *  of its chroma as sRGB shows there, as `#rrggbb` (what was measured is what is painted, never a
 *  browser's gamut mapping of it); the palette's text colour when none does. */
function fitInk(color: string, palette: Pick<Palette, "fg" | "bg4">, reads: (c: string) => boolean): string {
  if (reads(color)) return color;
  const lab = cssColorToOklab(color), fg = cssColorToOklab(palette.fg), under = cssColorToOklab(palette.bg4);
  if (!lab || !fg || !under) return color;
  const [l, a, b] = lab;
  const chroma = Math.hypot(a, b), hue = (Math.atan2(b, a) * 180) / Math.PI;
  const step = fg[0] > under[0] ? 0.005 : -0.005;
  for (let next = l + step; next > 0 && next < 1; next += step) {
    const ink = inGamut(next, chroma, hue);
    if (reads(ink)) return ink;
  }
  return palette.fg;
}

/** A status colour as chips and marks paint it for `palette` (`--color-status-failed`, the attention
 *  and unread colours): its word at 4.5:1 on its own chip and on the panel, its mark at 3:1 on every
 *  row and header. It is fitted to the panel, not the lightest surface, so a red stays red: a word
 *  drawn straight on a header or a selected row takes `statusTextInk`. Views are told this one. */
export function statusInk(color: string, palette: Pick<Palette, "fg" | (typeof STATUS_SURFACES)[number]>): string {
  return fitInk(color, palette, (c) =>
    atLeast(c, tint(c, CHIP_TINT, palette.bg2), STATUS_CONTRAST.word) && atLeast(c, palette.bg2, STATUS_CONTRAST.word) && marksRead(c, palette));
}

/** A status word drawn straight on any surface in `STATUS_SURFACES` (a tile header's label, a row's
 *  line under the pointer or selected): 4.5:1 on each, so paler than `statusInk` where those
 *  surfaces are light. */
export function statusTextInk(color: string, palette: Pick<Palette, "fg" | (typeof STATUS_SURFACES)[number]>): string {
  return fitInk(color, palette, (c) => STATUS_SURFACES.every((on) => atLeast(c, palette[on], STATUS_CONTRAST.word)));
}

/** The accent as a small mark (`--color-brand-mark`): `brand` itself when it reads at 3:1 on every
 *  surface in `ACCENT_MARK_SURFACES`, else the nearest colour of its hue that does. A theme's accent
 *  is checked on `ACCENT_SURFACES` and a picked one only warned about, so the mark is fitted here. */
export function accentMarkInk(brand: string, palette: Pick<Palette, "fg" | "bg4" | (typeof ACCENT_MARK_SURFACES)[number]>): string {
  return fitInk(brand, palette, (c) => ACCENT_MARK_SURFACES.every((on) => atLeast(c, palette[on], STATUS_CONTRAST.mark)));
}

/** The colour at lightness `l` and hue `h` with as much of chroma `c` as sRGB can show, as
 *  `#rrggbb`. Clipping each channel instead keeps a bright red's red at full and its lightness
 *  short of what was asked, so a Dracula red never got light enough to read on its selected row. */
function inGamut(l: number, c: number, h: number): string {
  for (let i = 16; ; i--) {
    const chroma = (c * i) / 16;
    const hex = cssColorToHex(`oklch(${l.toFixed(4)} ${chroma.toFixed(4)} ${h.toFixed(2)})`, "#000000");
    const back = cssColorToOklab(hex)!;
    if (i === 0 || Math.hypot(back[0] - l, back[1] - chroma * Math.cos((h * Math.PI) / 180), back[2] - chroma * Math.sin((h * Math.PI) / 180)) < 0.01) return hex;
  }
}

function terminalOf(v: unknown): TerminalPalette {
  if (!isObj(v)) return refuse("terminal is { background, foreground, cursor, selection, ansi }");
  if (!Array.isArray(v.ansi) || v.ansi.length !== 16) refuse("terminal.ansi lists the 16 ANSI colours, black to bright white");
  const colour = (x: unknown, field: string) => (isThemeColor(x) ? x.trim() : refuse(`${field} is not a colour this app reads`));
  return {
    background: opaque(v.background, "terminal.background"),
    foreground: opaque(v.foreground, "terminal.foreground"),
    cursor: colour(v.cursor, "terminal.cursor"),
    selection: colour(v.selection, "terminal.selection"),
    ansi: (v.ansi as unknown[]).map((c, i) => colour(c, `terminal.ansi.${i}`)),
  };
}

function wallpaperOf(v: unknown, files: readonly ThemeFolderFile[]): ThemeWallpaper {
  if (!isObj(v)) return refuse("wallpaper is { kind } for a built-in one, or { image } / { video } with a file in the folder");
  let brightness: number | undefined;
  if (v.brightness !== undefined) {
    if (typeof v.brightness !== "number" || !(v.brightness >= 0.4 && v.brightness <= 1.1)) refuse("wallpaper.brightness is from 0.4 to 1.1");
    brightness = v.brightness as number;
  }
  const b = brightness === undefined ? {} : { brightness };
  if (v.image !== undefined) return { image: fileIn(files, v.image, "wallpaper.image", IMAGE_EXT, "an image (.png, .jpg, .webp, .avif or .gif)", THEME_FILE_LIMITS.image), ...b };
  if (v.video !== undefined) return { video: fileIn(files, v.video, "wallpaper.video", VIDEO_EXT, "a video (.webm or .mp4)", THEME_FILE_LIMITS.video), ...b };
  const kinds: WallpaperId[] = WALLPAPERS.map((w) => w.id).filter((k) => k !== "image" && k !== "video" && k !== "shoal");
  if (!kinds.includes(v.kind as WallpaperId)) refuse(`wallpaper.kind is one of ${kinds.join(", ")}`);
  return { kind: v.kind as ThemeWallpaperKind, ...b };
}

function themeOf(raw: unknown, files: readonly ThemeFolderFile[]): Theme {
  if (!isObj(raw)) return refuse(`${THEME_MANIFEST} is a JSON object`);
  if (raw.format === undefined) refuse(`${THEME_MANIFEST} needs "format": ${THEME_FORMAT}`);
  if (typeof raw.format !== "number" || !Number.isInteger(raw.format) || raw.format < 1) refuse(`format is a whole number; this app reads format ${THEME_FORMAT}`);
  if ((raw.format as number) > THEME_FORMAT) refuse(`it is theme format ${raw.format}; this Hivemind reads format ${THEME_FORMAT}: update Hivemind to use it`);
  for (const k of Object.keys(raw)) {
    if ((RESERVED_THEME_PARTS as readonly string[]).includes(k)) refuse(`${k} is reserved for a later theme format; format ${THEME_FORMAT} does not draw it yet`);
    if (!FIELDS.has(k)) refuse(`${THEME_MANIFEST} has no field ${JSON.stringify(k).slice(0, 60)}; it takes ${[...FIELDS].filter((f) => f !== "$schema").join(", ")}`);
  }
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 60 || UNSAFE_TEXT.test(raw.name)) refuse("name is up to 60 characters of plain text");
  if (raw.mode !== "dark" && raw.mode !== "light") refuse('mode is "dark" or "light"');
  if (!isObj(raw.palette)) return refuse(`palette sets all of ${PALETTE_KEYS.join(", ")}`);
  const palIn = raw.palette;
  const missing = PALETTE_KEYS.filter((k) => palIn[k] === undefined);
  if (missing.length) refuse(`palette is missing ${missing.join(", ")}`);
  const extra = Object.keys(palIn).filter((k) => !(PALETTE_KEYS as readonly string[]).includes(k));
  if (extra.length) refuse(`palette has no key ${extra[0]}; it takes ${PALETTE_KEYS.join(", ")}`);
  const palette = Object.fromEntries(PALETTE_KEYS.map((k) => [k, opaque(palIn[k], `palette.${k}`)])) as Palette;
  const low = contrastProblem(palette);
  if (low) refuse(`palette: ${low}`);
  const diff = diffContrastProblem(palette, raw.mode as Theme["mode"]);
  if (diff) refuse(`palette: ${diff}`);
  const accent = accentOfTheme(raw.accent, palette);
  let radius: number | undefined;
  if (raw.radius !== undefined) {
    if (typeof raw.radius !== "number" || !(raw.radius >= 0 && raw.radius <= 24)) refuse("radius is from 0 to 24");
    radius = raw.radius as number;
  }
  let fonts: Theme["fonts"];
  if (raw.fonts !== undefined) {
    if (!isObj(raw.fonts) || Object.keys(raw.fonts).some((k) => k !== "ui" && k !== "mono")) refuse("fonts is { ui?, mono? }");
    const f = raw.fonts as Record<string, unknown>;
    fonts = { ...(f.ui !== undefined ? { ui: faceOf(f.ui, "fonts.ui", files) } : {}), ...(f.mono !== undefined ? { mono: faceOf(f.mono, "fonts.mono", files) } : {}) };
  }
  let sounds: Theme["sounds"];
  if (raw.sounds !== undefined) {
    if (!isObj(raw.sounds)) return refuse("sounds is { needs?, done?, error? }");
    const s = raw.sounds;
    const other = Object.keys(s).find((k) => !(MOMENTS as readonly string[]).includes(k));
    if (other) refuse(`sounds has no moment ${other}; it takes ${MOMENTS.join(", ")}`);
    sounds = Object.fromEntries(MOMENTS.filter((m) => s[m] !== undefined).map((m) => [m, fileIn(files, s[m], `sounds.${m}`, SOUND_EXT, "a sound (.ogg or .mp3)", THEME_FILE_LIMITS.sound)]));
  }
  return {
    format: 1, name: (raw.name as string).trim(), mode: raw.mode as Theme["mode"], palette, accent,
    ...(raw.terminal !== undefined ? { terminal: terminalOf(raw.terminal) } : {}),
    ...(radius !== undefined ? { radius } : {}),
    ...(fonts ? { fonts } : {}),
    ...(raw.wallpaper !== undefined ? { wallpaper: wallpaperOf(raw.wallpaper, files) } : {}),
    ...(sounds ? { sounds } : {}),
  };
}

/** Check a parsed `theme.json` against the files of its folder: the theme, or why it is refused. */
export function checkTheme(raw: unknown, files: readonly ThemeFolderFile[]): { theme: Theme } | { problem: string } {
  try { return { theme: themeOf(raw, files) }; } catch (e) {
    if (e instanceof Refused) return { problem: e.message };
    throw e;
  }
}

/** A theme's folder read from what it holds, the same in the app, `hive plugins check` and
 *  HiveHub: its folder's name, the package it is in, its `theme.json`'s text (null when there is
 *  none) and its files. Its id, `@owner/package/<folder>`, and the theme; or why it is refused. */
export function readTheme(folderName: string, packageId: string | undefined, json: string | null, files: readonly ThemeFolderFile[]): { id: string; theme: Theme } | { problem: string } {
  if (!packageId) return { problem: `a theme comes in a package: name its folder in a hivemind-package.json's "themes"` };
  if (!THEME_FOLDER_RE.test(folderName)) return { problem: `a theme's folder is named like its id: lowercase letters, digits and dashes, not ${JSON.stringify(folderName).slice(0, 80)}` };
  if (json === null) return { problem: `there is no ${THEME_MANIFEST} in the theme's folder` };
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return { problem: `${THEME_MANIFEST} is not valid JSON` }; }
  const r = checkTheme(raw, files);
  return "problem" in r ? { problem: `${THEME_MANIFEST}: ${r.problem}` } : { id: `${packageId}/${folderName}`, theme: r.theme };
}

/** Every file a theme names, as paths in its folder. */
export function themeFiles(t: Theme): string[] {
  const w = t.wallpaper;
  return [
    ...[t.fonts?.ui, t.fonts?.mono].flatMap((f) => f?.files.map((x) => x.path) ?? []),
    ...(w && "image" in w ? [w.image] : w && "video" in w ? [w.video] : []),
    ...Object.values(t.sounds ?? {}),
  ];
}

/** Five colours that tell a look apart at a glance, for a preset and a theme alike (Settings ▸
 *  Appearance): its page, its text, its accent, and its colours for done and failed. Not its panels
 *  or its terminal's ground, which sit so near the page in most looks that a strip of them reads as
 *  one colour three times. */
export function themeSwatches(t: Pick<Theme, "palette" | "accent">): string[] {
  const { brand } = typeof t.accent === "string" ? accentOf({ accent: t.accent }) : accentOf({ accent: "graphite" }, { accent: t.accent });
  return [t.palette.bg, t.palette.fg, brand, t.palette.ok, t.palette.err];
}

/** A `theme.json` for the look in use (`hive plugins new theme`): its colours, accent, terminal,
 *  corners and a built-in wallpaper. Font files, a picture wallpaper and sounds are files the
 *  author adds to the folder and names. */
export function themeFromLook(name: string, a: Appearance, extra: AppearanceExtra): Record<string, unknown> {
  // A picture, a video and Shoal are not a theme's to carry: the theme gets Mono in their place.
  const media = a.wallpaper.kind === "image" || a.wallpaper.kind === "video" || a.wallpaper.kind === "shoal";
  return {
    format: THEME_FORMAT,
    name,
    mode: a.mode,
    palette: { ...a.palette },
    accent: extra.accent ? { ...extra.accent } : a.accent === "amber" ? "graphite" : a.accent,
    terminal: { ...a.terminal, ansi: [...a.terminal.ansi] },
    radius: a.radius,
    wallpaper: { kind: media ? "mono" : a.wallpaper.kind, brightness: a.wallpaper.brightness },
  };
}
