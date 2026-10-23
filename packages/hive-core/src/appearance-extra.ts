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
import { ACCENTS, keptUnknown, mergeAppearance, type Appearance } from "./settings-schema.js";

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
const WEIGHT_RE = /^(?:normal|bold|[1-9]00(?: [1-9]00)?)$/;
const STYLE_RE = /^(?:normal|italic|oblique)$/;
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

function fontFacesOf(v: unknown): FontFaces | undefined {
  if (!isObj(v)) return undefined;
  const ui = faceSetOf(v.ui), mono = faceSetOf(v.mono);
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

/** The custom accent and font faces of `v`, checked: what a look keeps beside `appearance`. */
export function lookExtraOf(v: unknown): LookExtra {
  const p = isObj(v) ? v : {};
  const accent = accentColorsOf(p.accent);
  const fontFaces = fontFacesOf(p.fontFaces);
  return { ...(accent ? { accent } : {}), ...(fontFaces ? { fontFaces } : {}) };
}

function themeRecordOf(v: unknown): ThemeRecord | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !THEME_ID_RE.test(v.id) || !isObj(v.before)) return undefined;
  const name = typeof v.name === "string" && v.name.trim() && v.name.length <= 60 ? v.name : v.id.slice(v.id.lastIndexOf("/") + 1);
  const version = typeof v.version === "string" && VERSION_RE.test(v.version) ? v.version : "0.0.0";
  // `before` is the look a revert puts back: read as settings are, and never with a theme of its own.
  const before = { appearance: mergeAppearance(v.before.appearance), extra: lookExtraOf(v.before.extra) };
  const sounds = soundsOf(v.sounds);
  return {
    id: v.id, name, version,
    appliedAt: typeof v.appliedAt === "number" && Number.isFinite(v.appliedAt) ? v.appliedAt : 0,
    before,
    ...(sounds ? { sounds } : {}),
    ...(v.removed === true ? { removed: true } : {}),
  };
}

const KNOWN = new Set(["accent", "fontFaces", "theme"]);

/** `appearanceExtra` from anything (a file, a patch): each part checked, a part that fails
 *  dropped, and the keys a newer build added kept as they are. */
export function appearanceExtraOf(raw: unknown): AppearanceExtra {
  const p = isObj(raw) ? raw : {};
  const theme = themeRecordOf(p.theme);
  return { ...keptUnknown(p, KNOWN, {}), ...lookExtraOf(p), ...(theme ? { theme } : {}) };
}

/** The accent a look paints with: its custom colours when set, else its built-in id's. */
export function accentOf(appearance: Pick<Appearance, "accent">, extra?: Pick<AppearanceExtra, "accent"> | null): AccentColors & { custom: boolean } {
  if (extra?.accent) return { ...extra.accent, custom: true };
  const a = ACCENTS[appearance.accent] ?? ACCENTS.graphite;
  return { brand: a.brand, accent: a.accent, ...(a.working ? { working: a.working } : {}), custom: false };
}
