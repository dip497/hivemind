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
  state = next;
  applyTheme(state);
  for (const l of listeners) l();
});

// ── the runtime gate ────────────────────────────────────────────────────────
let fullWallpaper = true;
/** Workspace: whether the ACTIVE VIEW mounts the full-window wallpaper. */
export function setWallpaperActive(on: boolean): void {
  if (on === fullWallpaper) return;
  fullWallpaper = on;
  applyTheme(state);
  for (const l of listeners) l();
}
export function isWallpaperActive(): boolean { return fullWallpaper; }
/** Glass as it applies right now. */
export function effectiveGlass(t: ThemeState = state): boolean {
  return t.glass && (fullWallpaper || t.pluginSurfaces === "theme");
}
/** A host-placed slot in a scene paints the wallpaper behind itself (clipped
 *  to the slot) when the theme wants it there and nothing full-window does. */
export function slotWallpaper(t: ThemeState = state): boolean {
  return !fullWallpaper && t.pluginSurfaces === "theme" && t.glass && t.wallpaper !== "none";
}

export function applyTheme(t: ThemeState = state): void {
  if (typeof document === "undefined") return;
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
  // Palette tokens. The CSS carries the ubuntu values as its fallbacks, so the
  // default preset is a no-op; another preset recolours every surface at once.
  for (const k of PALETTE_KEYS) root.style.setProperty(`--color-${k}`, t.palette[k]);
  // Glass derives its translucent panels from these (see styles.css).
  root.style.setProperty("--surface-2", t.palette.bg2);
  root.style.setProperty("--surface-3", t.palette.bg3);
  root.style.setProperty("--surface-4", t.palette.bg4);
  root.style.setProperty("--radius-panel", `${t.radius}px`);
  root.style.setProperty("--font-ui-user", t.uiFont);
  root.style.setProperty("--font-mono-user", t.monoFont);
  const a = ACCENTS[t.accent];
  root.style.setProperty("--color-brand", a.brand);
  root.style.setProperty("--color-accent", a.accent);
  root.style.setProperty("--color-info", a.accent);
  root.style.setProperty("--primary", a.brand);
  root.style.setProperty("--ring", a.brand);
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
