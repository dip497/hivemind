/**
 * theme-store — the renderer's view of `settings.appearance` (settings.json).
 * Components read a FLAT theme (`useTheme()` → FlatTheme) and edit it with
 * `setTheme(patch)`; the store nests it back into the appearance section of
 * the settings store, which persists through main. `applyTheme` pushes the
 * theme into the DOM: `--color-*` palette tokens, surfaces, radius, fonts,
 * glass vars and classes, the accent — idempotent, called on every change.
 *
 * Glass has a runtime gate on top of the setting (`effectiveGlass`): the
 * workspace tells the store whether the active view mounts the full-window
 * wallpaper; under a view that paints its own scene (World, a community
 * plugin) glass + frosted content apply only when
 * `appearance.pluginSurfaces === "theme"` (the default: the user's theme wins
 * everywhere, painted behind each docked slot), and never when it is "opaque".
 */
import { useSyncExternalStore } from "react";
import {
  ACCENTS, ANCHORS, PALETTE_KEYS, WALLPAPERS, flattenAppearance, getPath, guestTheme, isPluginWallpaper, nestAppearance, wallpaperShown,
  type AccentId, type Appearance, type FlatTheme, type MediaAnchor, type MediaFit, type MediaLayer, type ThemePreset, type WallpaperId,
} from "@hivemind/core/settings-schema";
import { accentOf, presetPaths, withPreset, type AccentColors, type FontFaces } from "@hivemind/core/appearance-extra";
import { contrastRatio } from "@hivemind/core/css-color";
import { UNREAD_BLUE, accentMarkInk, statusInk, statusTextInk } from "@hivemind/core/theme-format";
import { DIFF_PALETTE_FIELDS, diffColours } from "@hivemind/core/diff-colours";
import { getSettings, patchSettingsMany, subscribeSettings } from "./settings-store";

export { ACCENTS, ANCHORS, WALLPAPERS };
export type { AccentId, MediaAnchor, MediaFit, MediaLayer, WallpaperId };
export type ThemeState = FlatTheme;

/** Legible-over-video defaults (one preset of glass settings, not a theme). */
export const CINEMATIC: Partial<ThemeState> = { glass: true, blur: 20, opacity: 0.78, videoBrightness: 0.55, contentGlass: false, animate: true };
/** A live scene seen through the tools (another preset of glass settings): thin frosted panels and
 *  tool content frosted too, so its creatures show behind both, softened behind the text. */
export const SEE_THROUGH: Partial<ThemeState> = { glass: true, blur: 14, opacity: 0.5, contentGlass: true, contentOpacity: 0.45 };

/** The person's own theme, as their settings say. */
let own: ThemeState = flattenAppearance(getSettings().appearance, getSettings().appearanceExtra);
/** The look of the host whose workspace is shown, while one is; null for this person's own. */
let host: Appearance | null = null;
/** What is painted: the host's look while its workspace is shown, else the person's own. */
let state: ThemeState = own;
const listeners = new Set<() => void>();
const shown = (): ThemeState => (host ? guestTheme(own, host) : own);
subscribeSettings(() => {
  own = flattenAppearance(getSettings().appearance, getSettings().appearanceExtra);
  show(shown());
});
/** Show a joined workspace in its host's look (`null`: this person's own workspace, own look). */
export function showHostLook(look: Appearance | null): void {
  host = look;
  show(shown());
}
function show(next: ThemeState): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  // Unchanged fields keep their object, so field subscribers skip the render.
  for (const k of Object.keys(next) as (keyof ThemeState)[]) {
    if (JSON.stringify(next[k]) === JSON.stringify(state[k])) (next as Record<keyof ThemeState, unknown>)[k] = state[k];
  }
  state = next;
  applyTheme(state);
  for (const l of listeners) l();
}

// ── the runtime gate ────────────────────────────────────────────────────────
let fullWallpaper = true;
let pluginScene = false;
/** Workspace: whether the ACTIVE VIEW mounts the full-window wallpaper. */
export function setWallpaperActive(on: boolean): void {
  if (on === fullWallpaper) return;
  fullWallpaper = on;
  applyTheme(state);
  for (const l of listeners) l();
}
/** Workspace: whether a plugin draws the ACTIVE VIEW. Separate from the wallpaper, which a
 *  plugin view gets too — "tools in scene views" is about the tools the host docks into it. */
export function setPluginScene(on: boolean): void {
  if (on === pluginScene) return;
  pluginScene = on;
  applyTheme(state);
  for (const l of listeners) l();
}
export function isWallpaperActive(): boolean { return fullWallpaper; }
/** Whether the wallpaper is drawn: behind glass, which is the person's, or a theme's without it.
 *  A theme's wallpaper is part of its look, so it shows whether or not glass is on. */
export function wallpaperDrawn(t: Pick<ThemeState, "glass" | "wallpaper" | "themeId"> = state): boolean {
  return wallpaperShown(t.wallpaper, t.glass, !!t.themeId);
}
/** Glass as it applies right now. */
export function effectiveGlass(t: ThemeState = state): boolean {
  // Nothing behind the glass means nothing to see through it: a translucent panel over the
  // page's own background only washes out the colour the theme picked.
  return t.glass && t.wallpaper !== "none" && (!pluginScene || t.pluginSurfaces === "theme");
}
/** A host-placed slot in a scene paints the wallpaper behind itself (clipped
 *  to the slot) when the theme wants it there and nothing full-window does. */
export function slotWallpaper(t: ThemeState = state): boolean {
  return !fullWallpaper && t.pluginSurfaces === "theme" && wallpaperDrawn(t);
}

/** The text on a button filled with `brand`: the palette's text or page colour, whichever reads
 *  better on it. */
function onBrand(brand: string, t: ThemeState): string {
  return (contrastRatio(t.palette.fg, brand) ?? 0) >= (contrastRatio(t.palette.bg, brand) ?? 0) ? t.palette.fg : t.palette.bg;
}

/** The status colours for this palette (core's `statusInk` and `statusTextInk`): chips and marks,
 *  and words drawn straight on a header or a selected row; and the accent as a small mark
 *  (`accentMarkInk`). Up to about 1 ms each to work out, so each is kept until the values it reads
 *  change, keyed on those values (a palette's object is rebuilt on every settings write): a slider
 *  repaints the theme on every move, and the accent picker on every pointer move, which works out
 *  only the accent's mark again. */
let statusKey = "";
let statusInks: Record<"failed" | "attention" | "unread" | "failedText" | "attentionText" | "unreadText", string> | null = null;
let markKey = "";
let brandMark = "";
function themeInks(t: ThemeState, brand: string): NonNullable<typeof statusInks> & { brandMark: string } {
  const p = t.palette;
  const sKey = [p.err, p.warn, p.fg, p.bg2, p.bg3, p.bg4].join(",");
  if (sKey !== statusKey || !statusInks) {
    statusKey = sKey;
    statusInks = {
      failed: statusInk(p.err, p), attention: statusInk(p.warn, p), unread: statusInk(UNREAD_BLUE, p),
      failedText: statusTextInk(p.err, p), attentionText: statusTextInk(p.warn, p), unreadText: statusTextInk(UNREAD_BLUE, p),
    };
  }
  const mKey = [brand, p.fg, p.bg, p.bg2, p.bg3, p.bg4].join(",");
  if (mKey !== markKey) { markKey = mKey; brandMark = accentMarkInk(brand, p); }
  return { ...statusInks, brandMark };
}

/** The `@font-face` rules a theme's font files make, kept in one <style> and rewritten only when
 *  they change: a font file loads once, not on every slider move. */
let lastFaces = "";
function paintFontFaces(faces: FontFaces | undefined): void {
  const key = faces ? JSON.stringify(faces) : "";
  if (key === lastFaces) return;
  lastFaces = key;
  let el = document.getElementById("hm-font-faces");
  if (!faces) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("style");
    el.id = "hm-font-faces";
    document.head.append(el);
  }
  // Family and URL were checked when settings were read (FAMILY_RE, MEDIA_URL_RE): no quote or
  // brace can reach this CSS.
  el.textContent = [faces.ui, faces.mono].flatMap((f) => f?.files.map((x) =>
    `@font-face{font-family:"${f.family}";src:url("${window.hive?.resourceUrl?.(x.url) ?? x.url}") format("woff2");font-display:swap;${x.weight ? `font-weight:${x.weight};` : ""}${x.style ? `font-style:${x.style};` : ""}}`) ?? []).join("\n");
}

/** What a colour change looks like, so only a real one pays for the suppression below. */
let lastColours = "";

/**
 * Repaint with every transition switched off for one frame.
 *
 * A preset or accent change rewrites every colour token at once. Anything with a colour
 * transition then animates together and the switch smears across a couple of hundred
 * milliseconds instead of snapping. Killing transitions, forcing the style flush, and
 * restoring on the next frame makes it instant — which is what a theme switch should be.
 */
function snapColours(paint: () => void): void {
  const off = document.createElement("style");
  off.append(document.createTextNode("*,*::before,*::after{transition:none !important}"));
  document.head.append(off);
  paint();
  void document.documentElement.offsetHeight; // flush, or the rule never applied
  // Two frames, not one: the override has to outlive the paint that commits the new
  // colours, or a single frame can drop it early and the tail of the change still animates.
  requestAnimationFrame(() => requestAnimationFrame(() => off.remove()));
}

export function applyTheme(t: ThemeState = state): void {
  if (typeof document === "undefined") return;
  // Sliders (blur, opacity, brightness) change no colour and must stay live under the
  // pointer; a preset, accent or mode change is the one that has to snap. Read defensively:
  // deciding how to paint must never be able to stop the painting.
  let colours = "";
  try {
    colours = `${t.preset}\u0000${t.accent}\u0000${JSON.stringify(t.accentCustom ?? null)}\u0000${t.mode}\u0000${PALETTE_KEYS.map((k) => t.palette?.[k]).join(",")}`;
  } catch { /* an incomplete theme still paints, it just does not snap */ }
  const snap = colours !== "" && lastColours !== "" && colours !== lastColours;
  lastColours = colours;
  if (snap) snapColours(() => paintTheme(t));
  else paintTheme(t);
}

function paintTheme(t: ThemeState): void {
  const root = document.documentElement;
  const glass = effectiveGlass(t);
  root.classList.toggle("glass-on", glass);
  root.classList.toggle("wp-static", !t.animate);
  root.classList.toggle("content-glass", glass && t.contentGlass);
  // A theme's wallpaper without glass: the canvas clears to show it, the panels stay solid.
  root.classList.toggle("wallpaper-on", !glass && wallpaperDrawn(t) && (!pluginScene || t.pluginSurfaces === "theme"));
  // Any picture behind the canvas, with glass or without: what the canvas draws straight on it (the
  // tile count, a frame's name, the selected tile's handle) takes a backing (styles.css).
  root.classList.toggle("wallpaper-drawn", wallpaperDrawn(t));
  root.dataset.themeMode = t.mode;
  // shadcn's `dark:` variant and Sonner read the class; the page starts dark (index.html).
  root.classList.toggle("dark", t.mode !== "light");
  root.dataset.preset = t.preset;
  root.style.setProperty("--glass-blur", `${t.blur}px`);
  root.style.setProperty("--glass-opacity", `${Math.round(t.opacity * 100)}%`);
  root.style.setProperty("--wp-brightness", String(t.videoBrightness ?? 0.85));
  root.style.setProperty("--content-opacity", `${Math.round(t.contentOpacity * 100)}%`);
  root.dataset.wallpaper = t.wallpaper;
  // A live scene, whose side panel is clear glass (styles.css).
  root.classList.toggle("live-wallpaper", isPluginWallpaper(t.wallpaper));
  // Palette tokens. The CSS carries the signal values as its fallbacks, so the
  // default preset is a no-op; another preset recolours every surface at once.
  // bg2/3/4 are NOT written here: they derive from --surface-* in CSS, so glass mode can
  // recolour them. An inline custom property beats every stylesheet rule, including html.glass-on.
  for (const k of PALETTE_KEYS) {
    if (k === "bg2" || k === "bg3" || k === "bg4") continue;
    root.style.setProperty(`--color-${k}`, t.palette[k]);
  }
  // Glass derives its translucent panels from these (see styles.css).
  root.style.setProperty("--surface-2", t.palette.bg2);
  root.style.setProperty("--surface-3", t.palette.bg3);
  root.style.setProperty("--surface-4", t.palette.bg4);
  // The band around a terminal is the terminal: it takes the preset's background, not a fixed one.
  root.style.setProperty("--color-terminal-bg", t.terminal.background);
  // Corners and fonts: styles.css builds its radius scale and font stacks on these.
  root.style.setProperty("--radius-user", `${t.radius}px`);
  root.style.setProperty("--font-ui-user", t.uiFont);
  root.style.setProperty("--font-mono-user", t.monoFont);
  const a = accentOf({ accent: t.accent }, { accent: t.accentCustom });
  const light = t.mode === "light";
  root.style.setProperty("--color-brand", a.brand);
  // Fitted to this palette (`themeInks`): status chips and marks, words straight on a header or a
  // selected row, and the accent where it is a small mark on a header or a card.
  const ink = themeInks(t, a.brand);
  root.style.setProperty("--color-status-failed", ink.failed);
  root.style.setProperty("--color-status-attention", ink.attention);
  root.style.setProperty("--color-unread", ink.unread);
  root.style.setProperty("--color-status-failed-text", ink.failedText);
  root.style.setProperty("--color-status-attention-text", ink.attentionText);
  root.style.setProperty("--color-unread-text", ink.unreadText);
  root.style.setProperty("--color-brand-mark", ink.brandMark);
  // A theme's accent, or one the person picked, also colours the switch that is on, the focus
  // ring and the primary button; the built-in presets keep Clean's calm monochrome (DESIGN.md).
  const marks = !!t.themeId || a.custom;
  root.classList.toggle("accent-marks", marks);
  if (marks) root.style.setProperty("--color-brand-fg", onBrand(a.brand, t));
  else root.style.removeProperty("--color-brand-fg");
  paintFontFaces(t.fontFaces);
  // The accents are pale tints made for a dark page; on a light one they would wash out, so text
  // and marks take the deeper brand colour, and a near-white "working" becomes the second text.
  root.style.setProperty("--color-status-working", a.working ? (light ? t.palette.fg2 : a.working) : a.brand);
  root.style.setProperty("--color-accent", light ? a.brand : a.accent);
  root.style.setProperty("--color-info", light ? a.brand : a.accent);
  // The editor's and every diff's colours, worked out to read on this palette's bg2 and a diff's
  // changed rows: 1 to 2 ms, so only when a value they read changes (keyed on those values, since a
  // palette's object is rebuilt on every settings write), not per slider move, wallpaper or scene
  // switch, and never per line.
  const key = [t.mode, ...DIFF_PALETTE_FIELDS.map((f) => t.palette[f])].join(",");
  if (diffFor.key !== key) diffFor = { key, colours: diffColours(t.palette, t.mode) };
  for (const [k, v] of Object.entries(diffFor.colours)) root.style.setProperty(k, v);
}
let diffFor: { key: string; colours: Record<string, string> } = { key: "", colours: {} };

export function getTheme(): ThemeState { return state; }

export function setTheme(patch: Partial<ThemeState>): void {
  // An edit is to the person's own theme, whatever is shown: a host's look is never saved as theirs.
  const before = nestAppearance(own);
  own = { ...own, ...patch };
  state = shown();
  applyTheme(state);
  for (const l of listeners) l();
  // Persist only the appearance sections this edit actually changed. A glass
  // slider then writes `appearance.glass` alone, so a `hive theme use` landing
  // mid-drag keeps its palette/terminal instead of being reverted wholesale.
  const after = nestAppearance(own);
  const changed: { path: string; value: unknown }[] = (Object.keys(after) as (keyof typeof after)[])
    .filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))
    .map((k) => ({ path: `appearance.${k}`, value: after[k] }));
  // The custom accent lives beside `appearance`, where an older build's write keeps it; leaving a
  // theme (`themeId: undefined`) forgets its record.
  if ("accentCustom" in patch) changed.push({ path: "appearanceExtra.accent", value: patch.accentCustom });
  if ("themeId" in patch && patch.themeId === undefined) changed.push({ path: "appearanceExtra.theme", value: undefined });
  patchSettingsMany(changed);
}

/** Choose a preset for the person's own theme (what is shown may be a host's): its colours, and
 *  without what core says a preset clears (`PRESET_CLEARS`: the custom accent that would win over
 *  its id, the record of a theme left behind). */
export function choosePreset(p: ThemePreset): void {
  // What `hive theme use` writes, path for path (`presetPaths`), each whether or not it reads as
  // changed here: an accent or mode a newer build wrote reads as the default, and the preset
  // replaces it. The settings' change repaints the person's own theme.
  const cur = getSettings();
  const next = withPreset(cur, p);
  patchSettingsMany(presetPaths(p, cur.appearance).map((path) => ({ path, value: getPath(next, path) })));
}

/** Paint with a built-in accent: its id, without the custom accent that would win over it. */
export function chooseAccent(id: AccentId): void {
  setTheme({ accent: id, accentCustom: undefined });
}

/** Paint with any colour as the accent, kept in `appearanceExtra.accent`; null goes back to the
 *  built-in accent. */
export function chooseAccentColours(colours: AccentColors | null): void {
  setTheme({ accentCustom: colours ?? undefined });
}

/** A fresh, empty overlay layer (a new stacked slot's defaults). */
export function newOverlay(): MediaLayer {
  return { id: genId(), url: null, kind: "image", opacity: 0.9, fit: "cover", size: 1, anchor: "center" };
}
function genId(): string {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `ov-${Math.random().toString(36).slice(2, 10)}`;
}
export function addOverlay(media: { id: string; url: string; kind: "video" | "image"; name?: string }): void {
  const layer: MediaLayer = { ...newOverlay(), id: media.id, url: media.url, kind: media.kind, name: media.name };
  setTheme({ overlayMedia: [...state.overlayMedia, layer] });
}
export function updateOverlay(id: string, patch: Partial<MediaLayer>): void {
  setTheme({ overlayMedia: state.overlayMedia.map((l) => (l.id === id ? { ...l, ...patch, id: l.id } : l)) });
}
export function removeOverlay(id: string): void {
  setTheme({ overlayMedia: state.overlayMedia.filter((l) => l.id !== id) });
}

function subscribe(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
export function useTheme(): ThemeState { return useSyncExternalStore(subscribe, getTheme, getTheme); }
/** One field of the theme; the component re-renders only when that field changes. */
export function useThemeField<K extends keyof ThemeState>(key: K): ThemeState[K] {
  const get = () => state[key];
  return useSyncExternalStore(subscribe, get, get);
}
/** A stable snapshot must include the runtime view gate as well as preferences.
 * Notifying useTheme alone cannot update a cached tile when its theme is unchanged. */
export function getSurfacePolicy(): { glass: boolean; slotWallpaper: boolean } {
  const glass = effectiveGlass();
  const wallpaper = slotWallpaper();
  return surfacePolicies[(glass ? 1 : 0) | (wallpaper ? 2 : 0)]!;
}
const surfacePolicies = [
  { glass: false, slotWallpaper: false },
  { glass: true, slotWallpaper: false },
  { glass: false, slotWallpaper: true },
  { glass: true, slotWallpaper: true },
] as const;
/** Re-renders when the effective glass / slot-wallpaper answer changes. */
export function useSurfacePolicy(): { glass: boolean; slotWallpaper: boolean } {
  return useSyncExternalStore(subscribe, getSurfacePolicy, getSurfacePolicy);
}

applyTheme(state);
