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

/** How custom media fills its layer. `tile` repeats the media (CSS background-repeat). */
export type MediaFit = "cover" | "contain" | "tile";

/** Where a sub-full overlay sits — one of a 3×3 grid of anchor cells. Ignored
 *  when `size` is 1 (the layer fills the whole window). */
export type MediaAnchor =
  | "top-left" | "top-center" | "top-right"
  | "center-left" | "center" | "center-right"
  | "bottom-left" | "bottom-center" | "bottom-right";

/** Row-major 3×3 anchor cells — also the render order for the grid picker. */
export const ANCHORS: MediaAnchor[] = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];

/** One user-supplied media layer — a background (behind the canvas) or a
 *  transparent overlay (over the tiles). `url` null = off (renders nothing). */
export interface MediaLayer {
  /** Stable id — distinguishes stacked overlays and keys each one's copied file
   *  (filename `overlay-<id>-<ts>.<ext>`) so replacing one never deletes another. */
  id: string;
  /** hivemedia:// URL of the picked file, or null when unset (nothing renders). */
  url: string | null;
  /** Whether `url` points at a video or an image (drives <video> vs <img>). */
  kind: "video" | "image";
  /** Display name of the original file (shown in the customizer). */
  name?: string;
  /** Layer opacity, 0–1. */
  opacity: number;
  /** Fill mode. */
  fit: MediaFit;
  /** Fraction of the window the layer occupies, 0.15–1. 1 = full-window (the
   *  `anchor` is then irrelevant); < 1 = a smaller box parked at `anchor`. */
  size: number;
  /** Which cell of the 3×3 grid a sub-full layer sits in. */
  anchor: MediaAnchor;
}

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
  /** Bring-your-own OVERLAY media — a STACK of fixed layers OVER the tiles, each
   *  always pointer-events:none, painted in array order (later = on top). Empty
   *  by default. The BACKGROUND is handled by the existing wallpaper
   *  (videoSrc/imageSrc), not here. */
  overlayMedia: MediaLayer[];
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
  overlayMedia: [],
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
      overlayMedia: loadOverlays(p.overlayMedia),
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A fresh, empty overlay layer (a new stacked slot's defaults). */
export function newOverlay(): MediaLayer {
  return { id: genId(), url: null, kind: "image", opacity: 0.9, fit: "cover", size: 1, anchor: "center" };
}

/** Best-effort unique id for an overlay layer / its copied file. */
function genId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `ov-${Math.random().toString(36).slice(2, 10)}`;
}

/** Hydrate a persisted MediaLayer onto a default template. Drops dead blob: URLs
 *  (in-memory, invalid after reload); only hivemedia:// URLs are persistent. */
function loadMedia(p: Partial<MediaLayer> | undefined, def: MediaLayer): MediaLayer {
  const fit: MediaFit = p?.fit === "contain" || p?.fit === "tile" || p?.fit === "cover" ? p.fit : def.fit;
  const url = typeof p?.url === "string" && p.url.startsWith("hivemedia://") ? p.url : null;
  const anchor: MediaAnchor = ANCHORS.includes(p?.anchor as MediaAnchor) ? (p!.anchor as MediaAnchor) : def.anchor;
  return {
    id: typeof p?.id === "string" && p.id ? p.id : genId(),
    url,
    kind: p?.kind === "video" ? "video" : "image",
    name: typeof p?.name === "string" ? p.name : undefined,
    opacity: clamp(typeof p?.opacity === "number" && !Number.isNaN(p.opacity) ? p.opacity : def.opacity, 0, 1),
    fit,
    size: clamp(typeof p?.size === "number" && !Number.isNaN(p.size) ? p.size : def.size, 0.15, 1),
    anchor,
  };
}

/** Hydrate the overlay STACK. Accepts the current array shape AND the legacy
 *  single-object shape (pre-multi-overlay), wrapping the latter in an array.
 *  Url-less layers are dropped — a slot only exists once it has a picked file. */
function loadOverlays(raw: unknown): MediaLayer[] {
  const tmpl = newOverlay();
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return items.map((x) => loadMedia(x as Partial<MediaLayer>, tmpl)).filter((m) => m.url);
}

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

/** Append a freshly-picked media file as a new overlay layer (top of the stack).
 *  `id` MUST be the slot id that was passed to `pickMedia` so the layer and its
 *  copied file agree — see main's per-slot file pruning. */
export function addOverlay(media: { id: string; url: string; kind: "video" | "image"; name?: string }): void {
  const layer: MediaLayer = { ...newOverlay(), id: media.id, url: media.url, kind: media.kind, name: media.name };
  setTheme({ overlayMedia: [...state.overlayMedia, layer] });
}

/** Merge a partial into ONE overlay layer (by id); persisted like the theme. */
export function updateOverlay(id: string, patch: Partial<MediaLayer>): void {
  setTheme({ overlayMedia: state.overlayMedia.map((l) => (l.id === id ? { ...l, ...patch, id: l.id } : l)) });
}

/** Remove one overlay layer from the stack. */
export function removeOverlay(id: string): void {
  setTheme({ overlayMedia: state.overlayMedia.filter((l) => l.id !== id) });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** React binding. Re-renders subscribers on any theme change. */
export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
