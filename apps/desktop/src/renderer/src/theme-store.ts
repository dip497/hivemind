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
  ACCENTS, ANCHORS, PALETTE_KEYS, WALLPAPERS, flattenAppearance, nestAppearance,
  type AccentId, type FlatTheme, type MediaAnchor, type MediaFit, type MediaLayer, type WallpaperId,
} from "@hivemind/core/settings-schema";
import { getSettings, patchSettingsMany, subscribeSettings } from "./settings-store";

export { ACCENTS, ANCHORS, WALLPAPERS };
export type { AccentId, MediaAnchor, MediaFit, MediaLayer, WallpaperId };
export type ThemeState = FlatTheme;

/** Legible-over-video defaults (one preset of glass settings, not a theme). */
export const CINEMATIC: Partial<ThemeState> = { glass: true, blur: 20, opacity: 0.78, videoBrightness: 0.55, contentGlass: false, animate: true };

let state: ThemeState = flattenAppearance(getSettings().appearance);
const listeners = new Set<() => void>();
subscribeSettings(() => {
  const next = flattenAppearance(getSettings().appearance);
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  // Unchanged fields keep their object, so field subscribers skip the render.
  for (const k of Object.keys(next) as (keyof ThemeState)[]) {
    if (JSON.stringify(next[k]) === JSON.stringify(state[k])) (next as Record<keyof ThemeState, unknown>)[k] = state[k];
  }
  state = next;
  applyTheme(state);
  for (const l of listeners) l();
});

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
/** Glass as it applies right now. */
export function effectiveGlass(t: ThemeState = state): boolean {
  // Nothing behind the glass means nothing to see through it: a translucent panel over the
  // page's own background only washes out the colour the theme picked.
  return t.glass && t.wallpaper !== "none" && (!pluginScene || t.pluginSurfaces === "theme");
}
/** A host-placed slot in a scene paints the wallpaper behind itself (clipped
 *  to the slot) when the theme wants it there and nothing full-window does. */
export function slotWallpaper(t: ThemeState = state): boolean {
  return !fullWallpaper && t.pluginSurfaces === "theme" && t.glass && t.wallpaper !== "none";
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
    colours = `${t.preset}\u0000${t.accent}\u0000${t.mode}\u0000${PALETTE_KEYS.map((k) => t.palette?.[k]).join(",")}`;
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
  root.dataset.themeMode = t.mode;
  root.dataset.preset = t.preset;
  root.style.setProperty("--glass-blur", `${t.blur}px`);
  root.style.setProperty("--glass-opacity", `${Math.round(t.opacity * 100)}%`);
  root.style.setProperty("--wp-brightness", String(t.videoBrightness ?? 0.85));
  root.style.setProperty("--content-opacity", `${Math.round(t.contentOpacity * 100)}%`);
  root.dataset.wallpaper = t.wallpaper;
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
  root.style.setProperty("--radius-panel", `${t.radius}px`);
  root.style.setProperty("--font-ui-user", t.uiFont);
  root.style.setProperty("--font-mono-user", t.monoFont);
  const a = ACCENTS[t.accent];
  root.style.setProperty("--color-brand", a.brand);
  root.style.setProperty("--color-status-working", a.working ?? a.brand);
  root.style.setProperty("--color-accent", a.accent);
  root.style.setProperty("--color-info", a.accent);
}

export function getTheme(): ThemeState { return state; }

export function setTheme(patch: Partial<ThemeState>): void {
  const before = nestAppearance(state);
  state = { ...state, ...patch };
  applyTheme(state);
  for (const l of listeners) l();
  // Persist only the appearance sections this edit actually changed. A glass
  // slider then writes `appearance.glass` alone, so a `hive theme use` landing
  // mid-drag keeps its palette/terminal instead of being reverted wholesale.
  const after = nestAppearance(state);
  const changed = (Object.keys(after) as (keyof typeof after)[])
    .filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))
    .map((k) => ({ path: `appearance.${k}`, value: after[k] }));
  patchSettingsMany(changed);
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
