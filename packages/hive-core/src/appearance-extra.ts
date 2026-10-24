/**
 * `appearanceExtra` — the appearance values an older build's write would erase, in a top-level
 * settings key of their own. Every write by a build before themes rebuilds `appearance` from the
 * keys it knows, and every release since 2026-09-21 keeps top-level keys it does not know, so a
 * value here survives an older app or `hive` writing the file (docs/plans/sounds-and-themes.md,
 * "Read first" §1). `appearance.accent` keeps a built-in id an older build accepts; the custom
 * accent here wins over it while it is set.
 *
 *   settings.appearanceExtra = {
 *     accent?:    { brand, accent, working? }        the custom accent
 *     fontFaces?: { ui?: FaceSet, mono?: FaceSet }   font files (`hivemedia:`) a theme brought
 *     theme?:     ThemeRecord                        the theme applied, with the look before it
 *   }
 *
 * Browser-safe: the renderer, main and the CLI read it through `mergeSettings`. Applying and
 * reverting a theme is `./theme-apply.ts`.
 */
import { cssColorToRgb } from "./css-color.js";
import { ACCENTS, applyPreset, mergeAppearance, themeFileOf, type Appearance, type ThemePreset } from "./settings-schema.js";

/** What a theme may have set: each path a part of the look a theme names, so Revert puts back
 *  those and nothing else. The accent is one part kept in two places (a built-in id an older
 *  build reads, the custom colours here); a font is the stack and the face it names. */
export const THEME_SET_PATHS = [
  "appearance.preset", "appearance.mode", "appearance.palette",
  "appearance.accent", "appearanceExtra.accent",
  "appearance.terminal", "appearance.radius", "appearance.wallpaper",
  "appearance.uiFont", "appearanceExtra.fontFaces.ui",
  "appearance.monoFont", "appearanceExtra.fontFaces.mono",
] as const;
export type ThemeSetPath = (typeof THEME_SET_PATHS)[number];

/** An accent as colours: what a built-in id names, or any colour a person or a theme picks. */
export interface AccentColors { brand: string; accent: string; working?: string }

/** One font file a face is drawn from: a `hivemedia://media/<file>.woff2` copied on apply. */
export interface FontFile { url: string; weight?: string; style?: string }
/** A family and the files that draw it. */
export interface FaceSet { family: string; files: FontFile[] }
export interface FontFaces { ui?: FaceSet; mono?: FaceSet }

/** The theme applied: which, when, and the look before it, so Revert is one step. */
export interface ThemeRecord {
  /** `@owner/package/theme`. */
  id: string;
  /** Its display name, such as "Harbour". */
  name: string;
  /** The package version applied. */
  version: string;
  appliedAt: number;
  /** The look before it was applied. Never holds a `theme` of its own, so it never nests. */
  before: { appearance: Appearance; extra: LookExtra };
  /** The parts of the look it set (`THEME_SET_PATHS`): what Revert puts back from `before`. */
  set: ThemeSetPath[];
  /** `hivemedia:` URLs of the sounds it brought, per moment. */
  sounds?: { needs?: string; done?: string; error?: string };
  /** Its package was removed; the look stays. */
  removed?: boolean;
}

export interface AppearanceExtra {
  accent?: AccentColors;
  fontFaces?: FontFaces;
  theme?: ThemeRecord;
}
/** What `before` keeps of the extra: everything but the record itself. */
export type LookExtra = Omit<AppearanceExtra, "theme">;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A colour a theme or a custom accent may use: one `cssColorToRgb` reads (hex, rgb(), oklch()),
 *  so its contrast can be worked out without a DOM. */
export const isThemeColor = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && cssColorToRgb(v) !== null;

export function accentColorsOf(v: unknown): AccentColors | undefined {
  if (!isObj(v) || !isThemeColor(v.brand) || !isThemeColor(v.accent)) return undefined;
  return { brand: v.brand.trim(), accent: v.accent.trim(), ...(isThemeColor(v.working) ? { working: v.working.trim() } : {}) };
}

/** A copied media file's address: `hivemedia://media/<file>`, the file a plain name in that folder. */
export const MEDIA_URL_RE = /^hivemedia:\/\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
/** A family name that is safe inside a CSS string: no quotes, backslashes, braces or semicolons. */
export const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/;
/** A font file's weight and style, as `@font-face` takes them. */
export const WEIGHT_RE = /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/;
export const STYLE_RE = /^(?:normal|italic|oblique)$/;
/** The most files one face may have. */
export const MAX_FACE_FILES = 4;

function faceSetOf(v: unknown): FaceSet | undefined {
  if (!isObj(v) || typeof v.family !== "string" || !FAMILY_RE.test(v.family) || !Array.isArray(v.files)) return undefined;
  const files = v.files.flatMap((f): FontFile[] => {
    if (!isObj(f) || typeof f.url !== "string" || !MEDIA_URL_RE.test(f.url) || !/\.woff2$/i.test(f.url)) return [];
    return [{ url: f.url, ...(typeof f.weight === "string" && WEIGHT_RE.test(f.weight) ? { weight: f.weight } : {}), ...(typeof f.style === "string" && STYLE_RE.test(f.style) ? { style: f.style } : {}) }];
  }).slice(0, MAX_FACE_FILES);
  return files.length ? { family: v.family, files } : undefined;
}

/** Whether a font stack (`"Harbour Display", system-ui, sans-serif`) names `family`. */
export function namesFamily(stack: string, family: string): boolean {
  const want = family.toLowerCase();
  return stack.split(",").some((x) => x.trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase() === want);
}

/** A face is kept only while its font names its family: once the person picks another font, no
 *  view is sent its bytes and the file can go. Without the fonts (a patch), every face is kept. */
function fontFacesOf(v: unknown, fonts?: Pick<Appearance, "uiFont" | "monoFont">): FontFaces | undefined {
  if (!isObj(v)) return undefined;
  const inUse = (f: FaceSet | undefined, stack: string | undefined) => (f && (stack === undefined || namesFamily(stack, f.family)) ? f : undefined);
  const ui = inUse(faceSetOf(v.ui), fonts?.uiFont), mono = inUse(faceSetOf(v.mono), fonts?.monoFont);
  return ui || mono ? { ...(ui ? { ui } : {}), ...(mono ? { mono } : {}) } : undefined;
}

/** A theme's id: `@owner/package/theme`. */
export const THEME_ID_RE = /^@[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SOUND_MOMENTS = ["needs", "done", "error"] as const;

function soundsOf(v: unknown): ThemeRecord["sounds"] {
  if (!isObj(v)) return undefined;
  const out: NonNullable<ThemeRecord["sounds"]> = {};
  for (const m of SOUND_MOMENTS) if (typeof v[m] === "string" && MEDIA_URL_RE.test(v[m] as string)) out[m] = v[m] as string;
  return Object.keys(out).length ? out : undefined;
}

/** The custom accent and font faces of `v`, checked: what a look keeps beside `appearance`, whose
 *  fonts (when given) decide which faces are still in use. */
export function lookExtraOf(v: unknown, fonts?: Pick<Appearance, "uiFont" | "monoFont">): LookExtra {
  const p = isObj(v) ? v : {};
  const accent = accentColorsOf(p.accent);
  const fontFaces = fontFacesOf(p.fontFaces, fonts);
  return { ...(accent ? { accent } : {}), ...(fontFaces ? { fontFaces } : {}) };
}

function themeRecordOf(v: unknown): ThemeRecord | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !THEME_ID_RE.test(v.id) || !isObj(v.before)) return undefined;
  const name = typeof v.name === "string" && v.name.trim() && v.name.length <= 60 ? v.name : v.id.slice(v.id.lastIndexOf("/") + 1);
  const version = typeof v.version === "string" && VERSION_RE.test(v.version) ? v.version : "0.0.0";
  // `before` is the look a revert puts back: read as settings are, and never with a theme of its own.
  const appearance = mergeAppearance(v.before.appearance);
  const before = { appearance, extra: lookExtraOf(v.before.extra, appearance) };
  const sounds = soundsOf(v.sounds);
  // A record that does not say what it set (or names nothing this build knows) puts back every part.
  const named = Array.isArray(v.set) ? THEME_SET_PATHS.filter((p) => (v.set as unknown[]).includes(p)) : [];
  return {
    id: v.id, name, version,
    appliedAt: typeof v.appliedAt === "number" && Number.isFinite(v.appliedAt) ? v.appliedAt : 0,
    before,
    set: named.length ? named : [...THEME_SET_PATHS],
    ...(sounds ? { sounds } : {}),
    ...(v.removed === true ? { removed: true } : {}),
  };
}

/** `appearanceExtra` from anything (a file, a patch): each part checked, a part that fails
 *  dropped, a font face its font no longer names left out. A key a newer build added is the
 *  writer's to keep (`./settings-write.ts`). */
export function appearanceExtraOf(raw: unknown, fonts?: Pick<Appearance, "uiFont" | "monoFont">): AppearanceExtra {
  const p = isObj(raw) ? raw : {};
  const theme = themeRecordOf(p.theme);
  return { ...lookExtraOf(p, fonts), ...(theme ? { theme } : {}) };
}

/** The accent a look paints with: its custom colours when set, else its built-in id's. */
export function accentOf(appearance: Pick<Appearance, "accent">, extra?: Pick<AppearanceExtra, "accent"> | null): AccentColors & { custom: boolean } {
  if (extra?.accent) return { ...extra.accent, custom: true };
  const a = ACCENTS[appearance.accent] ?? ACCENTS.graphite;
  return { brand: a.brand, accent: a.accent, ...(a.working ? { working: a.working } : {}), custom: false };
}

/** What choosing a built-in preset removes from `appearanceExtra`: the custom accent that would
 *  win over the preset's accent id, and the record of a theme the person has left. A theme's font
 *  faces stay while its family is still the font in use. */
export const PRESET_CLEARS = ["accent", "theme"] as const satisfies readonly (keyof AppearanceExtra)[];

/** The settings once a built-in preset is chosen (`PRESET_CLEARS`). */
export function withPreset<S extends { appearance: Appearance; appearanceExtra: AppearanceExtra }>(s: S, preset: ThemePreset): S {
  const rest: AppearanceExtra = { ...s.appearanceExtra };
  for (const k of PRESET_CLEARS) delete rest[k];
  return { ...s, appearance: applyPreset(s.appearance, preset), appearanceExtra: rest };
}

/** What choosing `preset` over the appearance `cur` writes (`withPreset`), by dotted path, for
 *  every writer of a preset (`hive theme use`, the app's picker). Its colours, accent, mode and
 *  id, and what it clears (`PRESET_CLEARS`), are written even where they read the same here: an
 *  id this build does not know (a newer build's accent or mode) reads as the default, and
 *  choosing a preset replaces it. The glass, wallpaper and corners only where the preset's look
 *  sets them or puts them back, so a newer build's wallpaper stays under a colour preset; the
 *  memory of the look before only where it changes, and then whole. */
export function presetPaths(preset: ThemePreset, cur: Appearance): string[] {
  const next = applyPreset(cur, preset);
  const look = preset.look ?? {};
  const changed = (k: keyof typeof look, was: unknown, now: unknown) => look[k] !== undefined || was !== now;
  return [
    ...(["preset", "mode", "palette", "accent", "terminal"] as const).map((k) => `appearance.${k}`),
    ...(changed("glass", cur.glass.enabled, next.glass.enabled) ? ["appearance.glass.enabled"] : []),
    ...(changed("wallpaper", cur.wallpaper.kind, next.wallpaper.kind) ? ["appearance.wallpaper.kind"] : []),
    ...(changed("radius", cur.radius, next.radius) ? ["appearance.radius"] : []),
    ...(JSON.stringify(cur.lookBefore) !== JSON.stringify(next.lookBefore) ? ["appearance.lookBefore"] : []),
    ...PRESET_CLEARS.map((k) => `appearanceExtra.${k}`),
  ];
}

/** The patches that choose a built-in accent id: the id, and no custom accent, which would win
 *  over it (`hive config set appearance.accent`). */
export function accentIdPatches(id: unknown): { path: string; value: unknown }[] {
  return [{ path: "appearance.accent", value: id }, { path: "appearanceExtra.accent", value: undefined }];
}

/** The parts of `appearanceExtra` importing a look file (`exportAppearance`'s, or a whole
 *  settings.json) sets, each with its value (undefined removes it). Its custom accent
 *  (`accentCustom`, or a settings.json's `appearanceExtra.accent`) is set; a file that names only
 *  an accent id paints that id, so no custom accent stays; and a file that names the colours (a
 *  palette or a preset) is a look of its own, so the record of the theme it replaces goes and
 *  Revert cannot undo the import. A part the file says nothing of is absent: it stays as it is,
 *  and is not written (`themeImportPaths`). */
export function importedExtraParts(raw: unknown): Pick<AppearanceExtra, "accent" | "theme"> {
  const file = themeFileOf(raw);
  const custom = accentColorsOf(file.accentCustom) ?? (isObj(raw) && isObj(raw.appearanceExtra) ? accentColorsOf(raw.appearanceExtra.accent) : undefined);
  return {
    ...(custom || "accent" in file ? { accent: custom } : {}),
    ...("palette" in file || "preset" in file ? { theme: undefined } : {}),
  };
}

/** `appearanceExtra` once a look file is imported over `cur` (`importedExtraParts`). */
export function importedExtra(raw: unknown, cur: AppearanceExtra): AppearanceExtra {
  const out: AppearanceExtra = { ...cur, ...importedExtraParts(raw) };
  if (!out.accent) delete out.accent;
  if (!out.theme) delete out.theme;
  return out;
}
