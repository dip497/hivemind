/**
 * Global app theme — glassmorphism + animated wallpaper + accent. This is an
 * APP preference, not a per-repo canvas setting, so it lives in its own
 * module-level store (one localStorage key, `hivemind:theme`) rather than in
 * PersistedLayout. `applyTheme()` pushes the state into CSS custom properties on
 * <html> and toggles the `glass-on` class, so styles.css can gate the entire
 * frosted-glass treatment behind one selector (and the existing per-frame
 * motion-strip rules keep blur off during pan/drag/resize for free).
 *
 * Read state in React via `useTheme()`; mutate via `setTheme(patch)`.
 */
import { useSyncExternalStore } from "react";

export type WallpaperId =
  | "none" | "aurora" | "ember" | "ice" | "mesh" | "sunset" | "forest" | "nebula" | "mono" | "image" | "video";
export type AccentId =
  | "indigo" | "volt" | "ember" | "ice" | "pulse" | "rose" | "emerald" | "amber" | "violet";

export interface ThemeState {
  /** Master frosted-glass toggle. When off, the app is the classic opaque dark theme. */
  glass: boolean;
  /** Backdrop blur radius in px (8–28; 16 is the readable sweet spot). */
  blur: number;
  /** Panel tint alpha, 0.30–0.95 — Clonk's "transparency" slider. Higher = more opaque. */
  opacity: number;
  /** Animated wallpaper behind the canvas pane. */
  wallpaper: WallpaperId;
  /** Accent palette (recolors brand + link accents app-wide). */
  accent: AccentId;
  /** Source for the `video` wallpaper — an hm-media:// (persistent) or blob: URL. */
  videoSrc?: string;
  /** Source for the `image` (Photo) wallpaper — an hm-media:// or blob:/data: URL. */
  imageSrc?: string;
  /** Video brightness multiplier, 0.40–1.10 (1.0 = original). Lower keeps frosted
   *  panels legible over a bright clip; higher preserves the clip's vibrancy. */
  videoBrightness?: number;
  /** Wallpaper motion: gradient blooms drift + photos get a slow Ken-Burns pan.
   *  Off = a still wallpaper (lighter, calmer). Video always plays regardless. */
  animate: boolean;
  /** Frost the tile CONTENT too (terminal/editor/diff), not just the chrome — the
   *  wallpaper bleeds through the whole tile. Opt-in; legibility drops over busy
   *  wallpapers, and the terminal relies on xterm transparency (WebGL-dependent). */
  contentGlass: boolean;
  /** Content tint alpha when contentGlass is on, 0.0–0.9. 0 = fully see-through,
   *  higher = a darker tint behind the text for legibility. */
  contentOpacity: number;
}

export const DEFAULT_THEME: ThemeState = {
  // Glass ON out of the box — it's the look. 0.72 keeps panels readable over the
  // wallpaper while still clearly frosted. Users can dial it down or turn it off.
  glass: true,
  blur: 18,
  opacity: 0.72,
  wallpaper: "aurora",
  accent: "indigo",
  videoBrightness: 0.85,
  animate: true,
  contentGlass: false,
  contentOpacity: 0.25,
};

/** Accent → brand/accent hex. Mirrors Clonk's Volt / Ember / Ice / Pulse set;
 *  `indigo` is hivemind's existing default (applying it is a visual no-op). */
export const ACCENTS: Record<AccentId, { label: string; brand: string; accent: string; swatch: string }> = {
  indigo:  { label: "Indigo",  brand: "#5b6cff", accent: "#38bdf8", swatch: "#5b6cff" },
  volt:    { label: "Volt",    brand: "#b6f23f", accent: "#a3e635", swatch: "#b6f23f" },
  ember:   { label: "Ember",   brand: "#ff7849", accent: "#fb923c", swatch: "#ff7849" },
  ice:     { label: "Ice",     brand: "#38bdf8", accent: "#22d3ee", swatch: "#38bdf8" },
  pulse:   { label: "Pulse",   brand: "#e879f9", accent: "#d946ef", swatch: "#e879f9" },
  rose:    { label: "Rose",    brand: "#fb7185", accent: "#f472b6", swatch: "#fb7185" },
  emerald: { label: "Emerald", brand: "#34d399", accent: "#10b981", swatch: "#34d399" },
  amber:   { label: "Amber",   brand: "#fbbf24", accent: "#f59e0b", swatch: "#fbbf24" },
  violet:  { label: "Violet",  brand: "#a78bfa", accent: "#8b5cf6", swatch: "#a78bfa" },
};

export const WALLPAPERS: { id: WallpaperId; label: string }[] = [
  { id: "none",   label: "None" },
  { id: "aurora", label: "Aurora" },
  { id: "ember",  label: "Ember" },
  { id: "ice",    label: "Ice" },
  { id: "mesh",   label: "Mesh" },
  { id: "sunset", label: "Sunset" },
  { id: "forest", label: "Forest" },
  { id: "nebula", label: "Nebula" },
  { id: "mono",   label: "Mono" },
  { id: "image",  label: "Photo" },
  { id: "video",  label: "Video" },
];

const KEY = "hivemind:theme";

function load(): ThemeState {
  if (typeof window === "undefined") return { ...DEFAULT_THEME };
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_THEME };
    const p = JSON.parse(raw) as Partial<ThemeState>;
    return {
      glass: typeof p.glass === "boolean" ? p.glass : DEFAULT_THEME.glass,
      blur: clamp(Number(p.blur) || DEFAULT_THEME.blur, 8, 24),
      opacity: clamp(Number(p.opacity) || DEFAULT_THEME.opacity, 0.3, 0.95),
      wallpaper: WALLPAPERS.some((w) => w.id === p.wallpaper) ? p.wallpaper! : DEFAULT_THEME.wallpaper,
      accent: p.accent && p.accent in ACCENTS ? p.accent : DEFAULT_THEME.accent,
      // Drop dead blob: URLs (in-memory, invalid after a reload) so a stale one
      // doesn't render black — the user is prompted to re-pick instead.
      videoSrc: typeof p.videoSrc === "string" && !p.videoSrc.startsWith("blob:") ? p.videoSrc : undefined,
      imageSrc: typeof p.imageSrc === "string" && !p.imageSrc.startsWith("blob:") ? p.imageSrc : undefined,
      videoBrightness: clamp(Number(p.videoBrightness) || DEFAULT_THEME.videoBrightness!, 0.4, 1.1),
      animate: typeof p.animate === "boolean" ? p.animate : DEFAULT_THEME.animate,
      contentGlass: typeof p.contentGlass === "boolean" ? p.contentGlass : DEFAULT_THEME.contentGlass,
      contentOpacity: clamp(typeof p.contentOpacity === "number" && !Number.isNaN(p.contentOpacity) ? p.contentOpacity : DEFAULT_THEME.contentOpacity, 0, 0.9),
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

let state: ThemeState = load();
const listeners = new Set<() => void>();

/** Push the current theme into the DOM: CSS vars on <html> + the `glass-on`
 *  class. Idempotent — safe to call on every change and once on boot. */
export function applyTheme(t: ThemeState = state): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("glass-on", t.glass);
  root.classList.toggle("wp-static", !t.animate);
  root.classList.toggle("content-glass", t.glass && t.contentGlass);
  root.style.setProperty("--glass-blur", `${t.blur}px`);
  // color-mix wants a percentage; opacity is the SOLID fraction of the panel.
  root.style.setProperty("--glass-opacity", `${Math.round(t.opacity * 100)}%`);
  root.style.setProperty("--wp-brightness", String(t.videoBrightness ?? 0.85));
  root.style.setProperty("--content-opacity", `${Math.round(t.contentOpacity * 100)}%`);
  root.dataset.wallpaper = t.wallpaper;
  const a = ACCENTS[t.accent];
  // Recolor brand + link accent (and the shadcn primary/ring aliases) live.
  // bg-[var(--color-brand)] etc. resolve the var at use-site, so this repaints
  // every accented surface without touching component code.
  root.style.setProperty("--color-brand", a.brand);
  root.style.setProperty("--color-accent", a.accent);
  root.style.setProperty("--color-info", a.accent);
  root.style.setProperty("--primary", a.brand);
  root.style.setProperty("--ring", a.brand);
}

export function getTheme(): ThemeState {
  return state;
}

export function setTheme(patch: Partial<ThemeState>): void {
  state = { ...state, ...patch };
  applyTheme(state);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* private mode / quota — theme is best-effort */ }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React binding. Re-renders subscribers on any theme change. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
