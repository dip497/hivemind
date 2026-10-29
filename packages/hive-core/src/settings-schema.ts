/**
 * settings.json — the ONE user-owned configuration of hivemind 2.0. Browser-safe
 * (no node imports): the desktop renderer, the main process and the `hive` CLI
 * all read and write this shape, and the presets + validation live here once.
 *
 *   <userData>/settings.json   { v: 1, appearance, views, plugins, agents }
 *
 * `appearance` is the single theme object (palette tokens, accent, radius,
 * fonts, glass, wallpaper, terminal palette, plugin-surface policy, overlay
 * media). Per-repo layout blobs stay in the renderer's localStorage — they are
 * cache, not configuration.
 */

import { isToolbarActionId, type ToolbarActionId, type ToolbarPreferences } from "./toolbar.js";
import { isPluginKey, isPluginOn, parsePluginStates, type PackageOf, type PluginState } from "./plugin-settings.js";
import { accentColorsOf, appearanceExtraOf, importedExtraParts, type AccentColors, type AppearanceExtra, type FontFaces } from "./appearance-extra.js";
import { FIELD_ID } from "@hivemind/view-sdk/settings";
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings, type NotificationSettings } from "./notification-settings.js";

// ── appearance ────────────────────────────────────────────────────────────────

export type WallpaperId =
  | "none" | "aurora" | "ember" | "ice" | "mesh" | "sunset" | "forest" | "nebula" | "mono"
  | "shoal" | "image" | "video";
export type AccentId =
  | "graphite" | "indigo" | "volt" | "ember" | "ice" | "pulse" | "rose" | "emerald" | "amber" | "violet";
export type MediaFit = "cover" | "contain" | "tile";
export type MediaAnchor =
  | "top-left" | "top-center" | "top-right"
  | "center-left" | "center" | "center-right"
  | "bottom-left" | "bottom-center" | "bottom-right";
export const ANCHORS: MediaAnchor[] = [
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right",
];

export interface MediaLayer {
  id: string;
  url: string | null;
  kind: "video" | "image";
  name?: string;
  opacity: number;
  fit: MediaFit;
  size: number;
  anchor: MediaAnchor;
}

/** Accent → brand/accent hex. `graphite` is the default; `indigo` was, before it.
 *  `working` is the colour of an agent at work, when it should not be the brand: brand also fills
 *  buttons under white text, and a working agent is not a call to action. */
export const ACCENTS: Record<AccentId, { label: string; brand: string; accent: string; swatch: string; working?: string }> = {
  graphite: { label: "Graphite", brand: "#5f6b7a", accent: "#a3b1c2", swatch: "#8b96a3", working: "#e2e5e9" },
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
  { id: "shoal",  label: "Shoal" },
  { id: "image",  label: "Photo" },
  { id: "video",  label: "Video" },
];

/** The live wallpapers: scenes drawn in characters behind the canvas whose creatures are the agents
 *  (apps/desktop live/). A theme cannot name one yet: an app without it would refuse the theme. */
export const LIVE_SCENES = ["shoal"] as const satisfies readonly WallpaperId[];
export type LiveSceneId = (typeof LIVE_SCENES)[number];
export const isLiveScene = (id: WallpaperId): id is LiveSceneId => (LIVE_SCENES as readonly WallpaperId[]).includes(id);

/** The `--color-*` tokens a preset sets. Values are CSS colours (oklch or hex). */
export const PALETTE_KEYS = ["bg", "bg2", "bg3", "bg4", "line", "line2", "fg", "fg2", "fg3", "select", "ok", "warn", "err"] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];
export type Palette = Record<PaletteKey, string>;

/** xterm palette: 4 special colours + the 16 ANSI colours in xterm order. */
export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  /** black, red, green, yellow, blue, magenta, cyan, white, then the 8 bright ones. */
  ansi: string[];
}

export interface Appearance {
  /** Preset id the palette + terminal were taken from (informational once edited). */
  preset: string;
  mode: "dark" | "light";
  palette: Palette;
  accent: AccentId;
  /** Corner radius scale in px (panels). */
  radius: number;
  uiFont: string;
  monoFont: string;
  glass: {
    enabled: boolean;
    contentGlass: boolean;
    /** Panel tint alpha 0.30–0.95. */
    opacity: number;
    /** Backdrop blur 8–24 px. */
    blur: number;
    /** Content tint alpha when contentGlass, 0–0.9. */
    contentOpacity: number;
    /** Wallpaper motion on/off. */
    animate: boolean;
  };
  wallpaper: {
    kind: WallpaperId;
    /** hm-media:// source for kind "video" / "image". */
    videoSrc?: string;
    imageSrc?: string;
    /** Video brightness 0.4–1.1. */
    brightness: number;
    /** A live scene in its own colours (water, coral, koi), not the theme's page and text. */
    colour: boolean;
  };
  terminal: TerminalPalette;
  /** Surfaces docked inside a World / community scene: "theme" renders them
   *  exactly as on the canvas (glass + wallpaper clipped to the slot);
   *  "opaque" uses the terminal background. */
  pluginSurfaces: "theme" | "opaque";
  overlayMedia: MediaLayer[];
  /** The glass, wallpaper and corners a whole-look preset (Clean) replaced, put back when the
   *  person leaves it for a colour preset. This computer's memory, not the look: never exported,
   *  imported or shown to a guest. */
  lookBefore?: LookBefore;
}

export interface LookBefore { glass: boolean; wallpaper: WallpaperId; radius: number }

export interface ThemePreset {
  id: string;
  label: string;
  mode: "dark" | "light";
  palette: Palette;
  accent: AccentId;
  terminal: TerminalPalette;
  /** More than colours: a preset that is a whole look also sets these. Leaving one out keeps the
   *  person's own. */
  look?: { glass?: boolean; wallpaper?: WallpaperId; radius?: number };
}

/** The look hivemind shipped with: the Plane/Linear neutral ladder and the
 *  Ubuntu / GNOME Terminal palette. Applying this preset is byte-identical to
 *  the pre-2.0 output (the CSS carries the same values as its fallbacks). */
export const UBUNTU: ThemePreset = {
  id: "ubuntu",
  label: "Ubuntu",
  mode: "dark",
  palette: {
    bg: "oklch(0.169 0.003 230.81)", bg2: "oklch(0.193 0.002 230.81)", bg3: "oklch(0.216 0.0025 230.82)", bg4: "oklch(0.259 0.0033 230.84)",
    line: "oklch(0.259 0.0033 230.84)", line2: "oklch(0.342 0.0049 230.86)",
    fg: "oklch(0.924 0.0017 230.69)", fg2: "oklch(0.846 0.0035 230.72)", fg3: "oklch(0.684 0.0074 230.81)",
    select: "oklch(0.846 0.0035 230.72)",
    ok: "oklch(0.70 0.19 152)", warn: "oklch(0.77 0.17 65)", err: "oklch(0.58 0.24 28)",
  },
  accent: "indigo",
  terminal: {
    background: "#300A24", foreground: "#FFFFFF", cursor: "#FFFFFF", selection: "rgba(255,255,255,0.25)",
    ansi: ["#2E3436", "#CC0000", "#4E9A06", "#C4A000", "#3465A4", "#75507B", "#06989A", "#D3D7CF",
           "#555753", "#EF2929", "#8AE234", "#FCE94F", "#729FCF", "#AD7FA8", "#34E2E2", "#EEEEEC"],
  },
};

/** The default. Neutral graphite, with colour kept for what needs you: an agent waiting on you is
 *  the one warm thing on screen, working is near-white, and nothing decorative borrows either. */
export const SIGNAL: ThemePreset = {
  id: "signal",
  label: "Signal",
  mode: "dark",
  palette: {
    bg: "oklch(0.165 0.004 250)", bg2: "oklch(0.195 0.004 250)", bg3: "oklch(0.23 0.005 250)", bg4: "oklch(0.27 0.005 250)",
    line: "oklch(0.27 0.005 250)", line2: "oklch(0.34 0.006 250)",
    fg: "oklch(0.93 0.004 250)", fg2: "oklch(0.80 0.005 250)", fg3: "oklch(0.62 0.006 250)",
    select: "oklch(0.80 0.005 250)",
    ok: "oklch(0.74 0.07 155)", warn: "oklch(0.80 0.13 72)", err: "oklch(0.66 0.11 32)",
  },
  accent: "graphite",
  terminal: {
    background: "#1A1C1F", foreground: "#E6E7E9", cursor: "#E6E7E9", selection: "rgba(230,231,233,0.22)",
    ansi: ["#2A2D32", "#C8756A", "#8FB39A", "#D9B26B", "#7D9BC4", "#A894C4", "#7FB3B8", "#D5D8DC",
           "#5A5F66", "#DC8B80", "#A6C8AF", "#E6C688", "#98B2D6", "#BDABD6", "#98C8CC", "#F0F1F3"],
  },
};

/** Clean: Signal made flat. The same graphite, the same one warm colour for what waits on you, with
 *  no glass and no wallpaper; corners and fonts stay the person's (apps/desktop/DESIGN.md). */
export const CLEAN: ThemePreset = {
  id: "clean",
  label: "Clean",
  mode: "dark",
  palette: { ...SIGNAL.palette },
  accent: "graphite",
  terminal: { ...SIGNAL.terminal, ansi: [...SIGNAL.terminal.ansi] },
  look: { glass: false, wallpaper: "none" },
};

/** Clean Light: Clean's light twin on the same graphite (hue 250), composed for light rather than
 *  inverted: a cooler ground under near-white sheets, ink and pencil that read on both, the status
 *  colours dark enough to read as text, and Signal's muted terminal hues darkened for a light ground. */
export const CLEAN_LIGHT: ThemePreset = {
  id: "clean-light",
  label: "Clean Light",
  mode: "light",
  palette: {
    bg: "oklch(0.955 0.004 250)", bg2: "oklch(0.99 0.002 250)", bg3: "oklch(0.965 0.003 250)", bg4: "oklch(0.93 0.004 250)",
    line: "oklch(0.9 0.004 250)", line2: "oklch(0.84 0.006 250)",
    fg: "oklch(0.24 0.006 250)", fg2: "oklch(0.42 0.006 250)", fg3: "oklch(0.52 0.006 250)",
    select: "oklch(0.42 0.006 250)",
    ok: "oklch(0.5 0.08 155)", warn: "oklch(0.5 0.13 62)", err: "oklch(0.52 0.13 30)",
  },
  accent: "graphite",
  terminal: {
    background: "#F6F7F8", foreground: "#2A2D32", cursor: "#2A2D32", selection: "rgba(42,45,50,0.16)",
    ansi: ["#2A2D32", "#A6564B", "#4E7A5C", "#8A6A24", "#4D6B94", "#735F97", "#3F7A80", "#7A7E85",
           "#5A5F66", "#B8665A", "#5E8C6C", "#9C7B33", "#5E7DA6", "#856FA9", "#4F8C92", "#A3A7AD"],
  },
  look: { glass: false, wallpaper: "none" },
};

export const PRESETS: Record<string, ThemePreset> = {
  signal: SIGNAL,
  clean: CLEAN,
  "clean-light": CLEAN_LIGHT,
  ubuntu: UBUNTU,
  dracula: {
    id: "dracula", label: "Dracula", mode: "dark", accent: "violet",
    palette: { bg: "#1e1f29", bg2: "#282a36", bg3: "#2f3140", bg4: "#44475a", line: "#3a3d4d", line2: "#565a70", fg: "#f8f8f2", fg2: "#d8d8d2", fg3: "#9a9cae", select: "#44475a", ok: "#50fa7b", warn: "#f1fa8c", err: "#ff5555" },
    terminal: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selection: "rgba(68,71,90,0.6)",
      ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] },
  },
  nord: {
    id: "nord", label: "Nord", mode: "dark", accent: "ice",
    palette: { bg: "#242933", bg2: "#2e3440", bg3: "#3b4252", bg4: "#434c5e", line: "#3b4252", line2: "#4c566a", fg: "#eceff4", fg2: "#d8dee9", fg3: "#9aa5b8", select: "#4c566a", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a" },
    terminal: { background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selection: "rgba(76,86,106,0.6)",
      ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"] },
  },
  "solarized-dark": {
    id: "solarized-dark", label: "Solarized Dark", mode: "dark", accent: "ice",
    palette: { bg: "#00212b", bg2: "#002b36", bg3: "#073642", bg4: "#0d4452", line: "#073642", line2: "#1b5a68", fg: "#eee8d5", fg2: "#93a1a1", fg3: "#657b83", select: "#073642", ok: "#859900", warn: "#b58900", err: "#dc322f" },
    terminal: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1", selection: "rgba(7,54,66,0.8)",
      ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"] },
  },
  "one-dark": {
    id: "one-dark", label: "One Dark", mode: "dark", accent: "ice",
    palette: { bg: "#21252b", bg2: "#282c34", bg3: "#2c313a", bg4: "#3e4451", line: "#3b4048", line2: "#4b5263", fg: "#dcdfe4", fg2: "#abb2bf", fg3: "#7f848e", select: "#3e4451", ok: "#98c379", warn: "#e5c07b", err: "#e06c75" },
    terminal: { background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selection: "rgba(62,68,81,0.7)",
      ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"] },
  },
  // The light ones are flat, as Clean Light is: glass over a dark wallpaper turns their sheets grey.
  "catppuccin-mocha": {
    id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark", accent: "violet",
    palette: { bg: "#181825", bg2: "#1e1e2e", bg3: "#313244", bg4: "#45475a", line: "#313244", line2: "#585b70", fg: "#cdd6f4", fg2: "#bac2de", fg3: "#9399b2", select: "#b4befe", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8" },
    terminal: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", selection: "rgba(88,91,112,0.6)",
      ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"] },
  },
  "catppuccin-latte": {
    id: "catppuccin-latte", label: "Catppuccin Latte", mode: "light", accent: "graphite",
    palette: { bg: "#dce0e8", bg2: "#eff1f5", bg3: "#e6e9ef", bg4: "#ccd0da", line: "#ccd0da", line2: "#bcc0cc", fg: "#4c4f69", fg2: "#5c5f77", fg3: "#6c6f85", select: "#7287fd", ok: "#40a02b", warn: "#df8e1d", err: "#d20f39" },
    terminal: { background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", selection: "rgba(172,176,190,0.6)",
      ansi: ["#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be", "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc"] },
    look: { glass: false, wallpaper: "none" },
  },
  "tokyo-night": {
    id: "tokyo-night", label: "Tokyo Night", mode: "dark", accent: "indigo",
    palette: { bg: "#16161e", bg2: "#1a1b26", bg3: "#292e42", bg4: "#3b4261", line: "#292e42", line2: "#545c7e", fg: "#c0caf5", fg2: "#a9b1d6", fg3: "#737aa2", select: "#7aa2f7", ok: "#9ece6a", warn: "#e0af68", err: "#f7768e" },
    terminal: { background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", selection: "rgba(59,66,97,0.7)",
      ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#ff899d", "#9fe044", "#faba4a", "#8db0ff", "#c7a9ff", "#a4daff", "#c0caf5"] },
  },
  "tokyo-night-day": {
    id: "tokyo-night-day", label: "Tokyo Night Day", mode: "light", accent: "graphite",
    palette: { bg: "#e1e2e7", bg2: "#e9eaee", bg3: "#e1e2e7", bg4: "#d0d5e3", line: "#c4c8da", line2: "#a8aecb", fg: "#3760bf", fg2: "#6172b0", fg3: "#68709a", select: "#2e7de9", ok: "#587539", warn: "#8c6c3e", err: "#f52a65" },
    terminal: { background: "#e1e2e7", foreground: "#3760bf", cursor: "#3760bf", selection: "rgba(168,174,203,0.6)",
      ansi: ["#b4b5b9", "#f52a65", "#587539", "#8c6c3e", "#2e7de9", "#9854f1", "#007197", "#6172b0", "#a1a6c5", "#ff4774", "#5c8524", "#a27629", "#358aff", "#a463ff", "#007ea8", "#3760bf"] },
    look: { glass: false, wallpaper: "none" },
  },
  "gruvbox-dark": {
    id: "gruvbox-dark", label: "Gruvbox Dark", mode: "dark", accent: "ember",
    palette: { bg: "#1d2021", bg2: "#282828", bg3: "#3c3836", bg4: "#504945", line: "#3c3836", line2: "#665c54", fg: "#ebdbb2", fg2: "#d5c4a1", fg3: "#a89984", select: "#83a598", ok: "#b8bb26", warn: "#fabd2f", err: "#fb4934" },
    terminal: { background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", selection: "rgba(80,73,69,0.7)",
      ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"] },
  },
  "gruvbox-light": {
    id: "gruvbox-light", label: "Gruvbox Light", mode: "light", accent: "graphite",
    palette: { bg: "#f2e5bc", bg2: "#fbf1c7", bg3: "#f2e5bc", bg4: "#ebdbb2", line: "#ebdbb2", line2: "#d5c4a1", fg: "#3c3836", fg2: "#504945", fg3: "#7c6f64", select: "#076678", ok: "#79740e", warn: "#b57614", err: "#9d0006" },
    terminal: { background: "#fbf1c7", foreground: "#3c3836", cursor: "#3c3836", selection: "rgba(213,196,161,0.7)",
      ansi: ["#fbf1c7", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64", "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#3c3836"] },
    look: { glass: false, wallpaper: "none" },
  },
  "rose-pine": {
    id: "rose-pine", label: "Rosé Pine", mode: "dark", accent: "violet",
    palette: { bg: "#16141f", bg2: "#191724", bg3: "#1f1d2e", bg4: "#26233a", line: "#26233a", line2: "#524f67", fg: "#e0def4", fg2: "#908caa", fg3: "#6e6a86", select: "#ebbcba", ok: "#9ccfd8", warn: "#f6c177", err: "#eb6f92" },
    terminal: { background: "#191724", foreground: "#e0def4", cursor: "#524f67", selection: "#403d52",
      ansi: ["#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4", "#6e6a86", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4"] },
  },
  "rose-pine-dawn": {
    id: "rose-pine-dawn", label: "Rosé Pine Dawn", mode: "light", accent: "graphite",
    palette: { bg: "#f2e9e1", bg2: "#fffaf3", bg3: "#faf4ed", bg4: "#dfdad9", line: "#dfdad9", line2: "#cecacd", fg: "#464261", fg2: "#797593", fg3: "#9893a5", select: "#907aa9", ok: "#56949f", warn: "#ea9d34", err: "#b4637a" },
    terminal: { background: "#faf4ed", foreground: "#575279", cursor: "#cecacd", selection: "#dfdad9",
      ansi: ["#f2e9e1", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279", "#9893a5", "#b4637a", "#286983", "#ea9d34", "#56949f", "#907aa9", "#d7827e", "#575279"] },
    look: { glass: false, wallpaper: "none" },
  },
  "github-dark": {
    id: "github-dark", label: "GitHub Dark", mode: "dark", accent: "indigo",
    palette: { bg: "#010409", bg2: "#0d1117", bg3: "#161b22", bg4: "#21262d", line: "#30363d", line2: "#484f58", fg: "#e6edf3", fg2: "#c9d1d9", fg3: "#8b949e", select: "#2f81f7", ok: "#3fb950", warn: "#d29922", err: "#f85149" },
    terminal: { background: "#0d1117", foreground: "#e6edf3", cursor: "#2f81f7", selection: "rgba(230,237,243,0.2)",
      ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"] },
  },
  "github-light": {
    id: "github-light", label: "GitHub Light", mode: "light", accent: "graphite",
    palette: { bg: "#f6f8fa", bg2: "#ffffff", bg3: "#f6f8fa", bg4: "#eaeef2", line: "#d0d7de", line2: "#afb8c1", fg: "#1f2328", fg2: "#424a53", fg3: "#656d76", select: "#0969da", ok: "#1a7f37", warn: "#9a6700", err: "#d1242f" },
    terminal: { background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", selection: "rgba(31,35,40,0.15)",
      ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"] },
    look: { glass: false, wallpaper: "none" },
  },
  "solarized-light": {
    id: "solarized-light", label: "Solarized Light", mode: "light", accent: "graphite",
    palette: { bg: "#eee8d5", bg2: "#fdf6e3", bg3: "#f5efdc", bg4: "#e6dfca", line: "#eee8d5", line2: "#d6cfb9", fg: "#073642", fg2: "#586e75", fg3: "#657b83", select: "#268bd2", ok: "#859900", warn: "#b58900", err: "#dc322f" },
    terminal: { background: "#fdf6e3", foreground: "#586e75", cursor: "#586e75", selection: "rgba(147,161,161,0.35)",
      ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"] },
    look: { glass: false, wallpaper: "none" },
  },
  monokai: {
    id: "monokai", label: "Monokai", mode: "dark", accent: "ember",
    palette: { bg: "#1e1f1c", bg2: "#272822", bg3: "#3e3d32", bg4: "#49483e", line: "#3e3d32", line2: "#75715e", fg: "#f8f8f2", fg2: "#cfcfc2", fg3: "#90908a", select: "#66d9ef", ok: "#a6e22e", warn: "#e6db74", err: "#f92672" },
    terminal: { background: "#272822", foreground: "#fdfff1", cursor: "#c0c1b5", selection: "#57584f",
      ansi: ["#272822", "#f92672", "#a6e22e", "#e6db74", "#fd971f", "#ae81ff", "#66d9ef", "#fdfff1", "#6e7066", "#f92672", "#a6e22e", "#e6db74", "#fd971f", "#ae81ff", "#66d9ef", "#fdfff1"] },
  },
};

/** The faces the app ships with (apps/desktop/DESIGN.md): the operating system's own UI font for the
 *  interface, JetBrains Mono for terminals and code. A font setting is a CSS font list, so the
 *  system's faces follow when one is missing. Geist, bundled, stays a choice. */
export const UI_FONT = "system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", Ubuntu, Cantarell, sans-serif";
export const MONO_FONT = "\"JetBrains Mono\", monospace";
export const GEIST_FONT = "\"Geist Sans\", \"Geist\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", Helvetica, Arial, sans-serif";
/** The system's own monospace, for a person who prefers it. */
export const SYSTEM_MONO_FONT = "ui-monospace, \"SF Mono\", Menlo, Consolas, \"DejaVu Sans Mono\", monospace";
/** What `uiFont` held before it was drawn, and what most settings.json files hold: the system font. */
export const OLD_UI_FONT_DEFAULT = "system-ui, sans-serif";

export const DEFAULT_APPEARANCE: Appearance = {
  preset: "signal",
  mode: "dark",
  palette: { ...SIGNAL.palette },
  accent: "graphite",
  radius: 12,
  uiFont: UI_FONT,
  monoFont: MONO_FONT,
  glass: { enabled: true, contentGlass: false, opacity: 0.72, blur: 18, contentOpacity: 0.25, animate: true },
  wallpaper: { kind: "mono", brightness: 0.85, colour: false },
  terminal: { ...SIGNAL.terminal, ansi: [...SIGNAL.terminal.ansi] },
  pluginSurfaces: "theme",
  overlayMedia: [],
};

/** The glass, wallpaper and corners once `next` is chosen over the preset `from`, and what to
 *  remember. A whole-look preset sets its own and remembers what it replaced (moving to another
 *  keeps the first memory); leaving it for a colour preset puts each back, unless the person
 *  changed it since. */
function lookAfter(cur: LookBefore, before: LookBefore | undefined, from: string, next: ThemePreset): LookBefore & { before?: LookBefore } {
  const was = PRESETS[from]?.look;
  const look = next.look;
  if (look) return { glass: look.glass ?? cur.glass, wallpaper: look.wallpaper ?? cur.wallpaper, radius: look.radius ?? cur.radius, before: was ? before : cur };
  if (!was || !before) return cur;
  const back = <K extends keyof LookBefore>(k: K) => (was[k] !== undefined && cur[k] === was[k] ? before[k] : cur[k]);
  return { glass: back("glass"), wallpaper: back("wallpaper"), radius: back("radius") };
}

/** Apply a preset on top of an appearance: palette, terminal, accent, mode, id, and its look. */
export function applyPreset(a: Appearance, preset: ThemePreset): Appearance {
  const { lookBefore, ...rest } = a;
  const l = lookAfter({ glass: a.glass.enabled, wallpaper: a.wallpaper.kind, radius: a.radius }, lookBefore, a.preset, preset);
  return {
    ...rest, preset: preset.id, mode: preset.mode, palette: { ...preset.palette }, accent: preset.accent,
    terminal: { ...preset.terminal, ansi: [...preset.terminal.ansi] },
    glass: { ...a.glass, enabled: l.glass }, wallpaper: { ...a.wallpaper, kind: l.wallpaper }, radius: l.radius,
    ...(l.before ? { lookBefore: l.before } : {}),
  };
}

/** xterm `ITheme` for an appearance. Key order matches the pre-2.0 literal
 *  (the golden test compares them deeply). */
export function terminalThemeFor(t: TerminalPalette): Record<string, string> {
  const a = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.background,
    selectionBackground: t.selection,
    black: a[0]!, brightBlack: a[8]!,
    red: a[1]!, brightRed: a[9]!,
    green: a[2]!, brightGreen: a[10]!,
    yellow: a[3]!, brightYellow: a[11]!,
    blue: a[4]!, brightBlue: a[12]!,
    magenta: a[5]!, brightMagenta: a[13]!,
    cyan: a[6]!, brightCyan: a[14]!,
    white: a[7]!, brightWhite: a[15]!,
  };
}

// ── the other sections ───────────────────────────────────────────────────────

/** Tool-island placement in one view. `hidden` keeps the collapsed handle;
 *  `off` shows nothing at all (the keyboard shortcuts still work). */
export type IslandPlacement = "top" | "bottom" | "hidden" | "off";
export const ISLAND_PLACEMENTS: readonly IslandPlacement[] = ["top", "bottom", "hidden", "off"];

/** How the Layers panel lists tiles (its View menu): which, grouped how, in what order. */
export const LAYERS_STATUS = ["all", "needs-you", "unread", "working", "idle", "exited"] as const;
export const LAYERS_ACTIVITY = ["all", "hour", "today", "week"] as const;
export const LAYERS_GROUP_BY = ["machine", "group", "date", "status", "agent", "none"] as const;
export const LAYERS_SORT_BY = ["canvas", "activity", "name"] as const;
/** How Recents groups past sessions: by the agent, by the project (folder) they ran in, by day, or not. */
export const LAYERS_RECENTS_BY = ["agent", "project", "date", "none"] as const;
/** Whether a row shows what its agent waits on under its name, or nothing. */
export const LAYERS_LINES = ["needs-you", "off"] as const;
export interface LayersPrefs {
  /** Only the tiles in this state. */
  status: (typeof LAYERS_STATUS)[number];
  /** Only the tiles whose status changed within this long. */
  activity: (typeof LAYERS_ACTIVITY)[number];
  groupBy: (typeof LAYERS_GROUP_BY)[number];
  sortBy: (typeof LAYERS_SORT_BY)[number];
  /** Only the tiles on these computers ("local", or a machine's id); empty: every one. */
  machines: string[];
  recentsBy: (typeof LAYERS_RECENTS_BY)[number];
  lines: (typeof LAYERS_LINES)[number];
}
export const DEFAULT_LAYERS_PREFS: LayersPrefs = { status: "all", activity: "all", groupBy: "group", sortBy: "canvas", machines: [], recentsBy: "agent", lines: "needs-you" };

export interface ViewsSettings {
  /** The view to open with (a registered id; unknown → canvas). */
  defaultView: string;
  /** Per-view chrome overrides: where the tool island sits in that view.
   *  `hidden` collapses it to the handle that expands it again — a view can
   *  never strand the user without a way to spawn. `off` removes it entirely
   *  (no handle): for a view that provides its own controls, or a user who
   *  drives everything from the keyboard. Absent = the view plugin's default. */
  chrome: Record<string, { island?: IslandPlacement }>;
  /** Per-view toolbar overrides: which standard actions, in which order, and
   *  whether they carry text labels. Absent view = the catalog defaults; see
   *  `resolveToolbar`. Presentation only — never an availability decision. */
  toolbars: Record<string, ToolbarPreferences>;
  /** The Layers panel's View menu, for every view that shows it. */
  layers: LayersPrefs;
}
export interface PluginsSettings {
  /** Every plugin's stored state, by `<kind>:<id>` (plugin-settings.ts): whether it is on, and
   *  the values set for its fields. One record for every kind of plugin. */
  state: Record<string, PluginState>;
}
/** Which tool plugins are on, and which of their tools are off: what the tool registry takes,
 *  worked out from the plugins' stored state (`toolPreferences`). Never stored as such. */
export interface ToolsSettings {
  /** Tool plugins switched ON. A tool plugin that is not built in is off until switched on. */
  enabledPlugins: string[];
  /** Individual tool ids (`<plugin>/<tool>`) switched off inside a plugin. */
  disabledTools: string[];
}
export interface AgentsSettings {
  defaultAgent: string;
  /** Add catalog agents whose CLI is found on this machine, without asking. */
  autoInstall: boolean;
  /** Catalog agents the user removed: never added automatically again. */
  declined: string[];
  /** Agents that came from the plugin catalog, so their page can say where they are from. */
  fromCatalog: string[];
  /** When an agent or a program starts an agent: `stay` where the person is, the new tile marked
   *  unread in Layers, or `go` to it. One the person starts is always gone to. */
  whenAgentStartsAgent: WhenAgentStartsAgent;
}
export const WHEN_AGENT_STARTS_AGENT = ["stay", "go"] as const;
export type WhenAgentStartsAgent = (typeof WHEN_AGENT_STARTS_AGENT)[number];
/** Who you are to the people you work with (R3): the name and colour they see beside your cursor
 *  and your edits. Each is empty until chosen. */
export interface ProfileSettings {
  /** Trimmed, at most 64 characters, no control characters. */
  name: string;
  /** `#rrggbb`, lowercase. */
  color: string;
}
/** Settings → About and updates (R16): what this app reaches outside the network profile's servers. */
export interface NetworkSettings {
  /** Ask, now and then, whether a newer release is out (GitHub) and whether the agents the app
   *  adds by itself have new versions (the plugin catalog). Off: the app reaches nothing the
   *  network profile does not name, unless the person browses plugins. */
  updateCheck: boolean;
}
/** Settings → Advanced → In a browser (docs/design/browser-app-2026-10-13.md): the app served
 *  to a browser on 127.0.0.1, off until the person turns it on. */
export interface BrowserAppSettings {
  enabled: boolean;
  /** 1024–65535. Fixed, so a `tailscale serve` set up for it keeps working. */
  port: number;
  /** Host names a request may name besides 127.0.0.1 and localhost, each with the port a browser
   *  uses when it is not 443: the machine's tailnet name as `tailscale serve` gives it. */
  names: string[];
}
/** What quitting the app does while terminals or agents run on this computer. */
export const QUIT_CHOICES = ["ask", "keep-running", "stop-everything"] as const;
export type QuitChoice = (typeof QUIT_CHOICES)[number];
export interface QuitSettings {
  /** `keep-running`: they go on in the background process. `stop-everything`: it stops, each
   *  session saved to come back when it next starts. `ask`: the app asks each time. */
  whenRunning: QuitChoice;
}
/** The format of settings.json this build reads and writes (`v`). A file from a newer build says
 *  more: it is read for what this build knows, and a write here never lowers it. */
export const SETTINGS_VERSION = 1;

/** The format version a file says it is: a whole number from 1, or 1 for anything else. Every
 *  build so far wrote `v: 1`, so a file without one (written by hand) or with one below 1 (no build
 *  wrote it) has the first shape. */
export function settingsVersionOf(raw: unknown): number {
  const v = isObj(raw) ? raw.v : undefined;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 1;
}

export interface Settings {
  /** The file's format version as read (`settingsVersionOf`); above `SETTINGS_VERSION`, a newer
   *  build wrote it. Not a setting: a write keeps the file's. */
  v: number;
  appearance: Appearance;
  /** The look's values an older build's write would erase: the custom accent, font faces and
   *  the theme applied (`./appearance-extra.ts`). Read on top of `appearance`. */
  appearanceExtra: AppearanceExtra;
  views: ViewsSettings;
  plugins: PluginsSettings;
  agents: AgentsSettings;
  profile: ProfileSettings;
  network: NetworkSettings;
  browserApp: BrowserAppSettings;
  quit: QuitSettings;
  /** Toasts, OS pop-ups and sounds (`notification-settings.ts`). Before 2026-10 the app kept them
   *  in a settings.json of its data folder; migration 0006 moved them here. */
  notifications: NotificationSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  appearance: DEFAULT_APPEARANCE,
  appearanceExtra: {},
  views: { defaultView: "canvas", chrome: {}, toolbars: {}, layers: DEFAULT_LAYERS_PREFS },
  // Fresh install: every plugin as it is by default (a tool plugin that is not built in: off).
  plugins: { state: {} },
  // Empty = "the agent catalog's default" — hive-core does not depend on
  // @hivemind/agents; preferredAgent() turns an empty or unknown id into the first installed agent.
  agents: { defaultAgent: "", autoInstall: true, declined: [], fromCatalog: [], whenAgentStartsAgent: "stay" },
  profile: { name: "", color: "" },
  network: { updateCheck: true },
  browserApp: { enabled: false, port: 4483, names: [] },
  quit: { whenRunning: "ask" },
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
};

// ── validation / merge ───────────────────────────────────────────────────────

const clamp = (n: unknown, lo: number, hi: number, def: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : def;
  return Math.min(hi, Math.max(lo, v));
};
const str = (v: unknown, def: string, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : def);
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|[a-z]{3,20})$/;
const color = (v: unknown, def: string) => (typeof v === "string" && COLOR_RE.test(v.trim()) ? v.trim() : def);

function mediaLayer(p: unknown, i: number): MediaLayer | null {
  if (!isObj(p)) return null;
  const url = typeof p.url === "string" && p.url.startsWith("hivemedia://") ? p.url : null;
  if (!url) return null;
  return {
    id: str(p.id, `ov-${i}`),
    url,
    kind: p.kind === "video" ? "video" : "image",
    name: typeof p.name === "string" ? p.name : undefined,
    opacity: clamp(p.opacity, 0, 1, 0.9),
    fit: p.fit === "contain" || p.fit === "tile" ? p.fit : "cover",
    size: clamp(p.size, 0.15, 1, 1),
    anchor: ANCHORS.includes(p.anchor as MediaAnchor) ? (p.anchor as MediaAnchor) : "center",
  };
}

/** The keys of a look, as a theme file holds them. */
const THEME_KEYS = new Set(Object.keys(DEFAULT_APPEARANCE));

function lookBeforeOf(v: unknown): LookBefore | undefined {
  if (!isObj(v) || typeof v.glass !== "boolean" || !WALLPAPERS.some((x) => x.id === v.wallpaper)) return undefined;
  return { glass: v.glass, wallpaper: v.wallpaper as WallpaperId, radius: clamp(v.radius, 0, 24, DEFAULT_APPEARANCE.radius) };
}

export function mergeAppearance(raw: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const p = isObj(raw) ? raw : {};
  const preset = str(p.preset, base.preset, 64);
  const palIn = isObj(p.palette) ? p.palette : {};
  const palette = Object.fromEntries(PALETTE_KEYS.map((k) => [k, color(palIn[k], base.palette[k])])) as Palette;
  const g = isObj(p.glass) ? p.glass : {};
  const w = isObj(p.wallpaper) ? p.wallpaper : {};
  const t = isObj(p.terminal) ? p.terminal : {};
  const ansiIn = Array.isArray(t.ansi) ? t.ansi : [];
  const ansi = base.terminal.ansi.map((d, i) => color(ansiIn[i], d));
  const srcOk = (v: unknown) => (typeof v === "string" && !v.startsWith("blob:") ? v : undefined);
  // Only as `raw` has it: a write that drops it (leaving Clean) forgets it.
  const lookBefore = lookBeforeOf(p.lookBefore);
  return {
    preset,
    mode: p.mode === "light" || p.mode === "dark" ? p.mode : base.mode,
    palette,
    accent: typeof p.accent === "string" && p.accent in ACCENTS ? (p.accent as AccentId) : base.accent,
    radius: clamp(p.radius, 0, 24, base.radius),
    uiFont: str(p.uiFont, base.uiFont),
    monoFont: str(p.monoFont, base.monoFont),
    glass: {
      enabled: bool(g.enabled, base.glass.enabled),
      contentGlass: bool(g.contentGlass, base.glass.contentGlass),
      opacity: clamp(g.opacity, 0.3, 0.95, base.glass.opacity),
      blur: clamp(g.blur, 8, 24, base.glass.blur),
      contentOpacity: clamp(g.contentOpacity, 0, 0.9, base.glass.contentOpacity),
      animate: bool(g.animate, base.glass.animate),
    },
    wallpaper: {
      kind: WALLPAPERS.some((x) => x.id === w.kind) ? (w.kind as WallpaperId) : base.wallpaper.kind,
      videoSrc: srcOk(w.videoSrc),
      imageSrc: srcOk(w.imageSrc),
      brightness: clamp(w.brightness, 0.4, 1.1, base.wallpaper.brightness),
      colour: bool(w.colour, base.wallpaper.colour),
    },
    terminal: {
      background: color(t.background, base.terminal.background),
      foreground: color(t.foreground, base.terminal.foreground),
      cursor: color(t.cursor, base.terminal.cursor),
      selection: color(t.selection, base.terminal.selection),
      ansi,
    },
    pluginSurfaces: p.pluginSurfaces === "opaque" || p.pluginSurfaces === "theme" ? p.pluginSurfaces : base.pluginSurfaces,
    overlayMedia: (Array.isArray(p.overlayMedia) ? p.overlayMedia : []).map(mediaLayer).filter((m): m is MediaLayer => !!m),
    ...(lookBefore ? { lookBefore } : {}),
  };
}

/** A host's look as a guest shows it, from anything (a peer's message is untrusted): checked as
 *  settings are, with nothing that names a file on the host's disk. A picture or video wallpaper
 *  becomes the default one, and overlays go: their media is the host's alone. Fonts are not the
 *  look: a guest reads in their own, so the host's are not sent. Each field is named: a field
 *  added later, or one a newer build wrote, reaches guests only when it is added here. */
export function sharedAppearance(raw: unknown): SharedAppearance {
  const a = mergeAppearance(raw);
  const media = a.wallpaper.kind === "image" || a.wallpaper.kind === "video";
  // The custom accent (a theme's colours), as `lookForGuests` adds it: a colour, never a file.
  const accentCustom = accentColorsOf((raw as { accentCustom?: unknown } | null)?.accentCustom);
  return {
    ...(accentCustom ? { accentCustom } : {}),
    preset: a.preset,
    mode: a.mode,
    palette: a.palette,
    accent: a.accent,
    radius: a.radius,
    uiFont: DEFAULT_APPEARANCE.uiFont,
    monoFont: DEFAULT_APPEARANCE.monoFont,
    glass: a.glass,
    wallpaper: { kind: media ? DEFAULT_APPEARANCE.wallpaper.kind : a.wallpaper.kind, brightness: a.wallpaper.brightness, colour: a.wallpaper.colour },
    terminal: a.terminal,
    pluginSurfaces: a.pluginSurfaces,
    overlayMedia: [],
  };
}

/** A host's look as guests get it: its appearance, and its custom accent when one is set. */
export type SharedAppearance = Appearance & { accentCustom?: AccentColors };

/** What a host sends its guests, before `sharedAppearance` takes out what is its own: the
 *  appearance with the custom accent of its `appearanceExtra`. */
export function lookForGuests(s: Pick<Settings, "appearance" | "appearanceExtra">): SharedAppearance {
  return { ...s.appearance, ...(s.appearanceExtra.accent ? { accentCustom: s.appearanceExtra.accent } : {}) };
}

/** A theme file (`hive theme export`, Copy JSON): the appearance without the media it names. */
export type ThemeFile = Omit<Appearance, "wallpaper" | "overlayMedia"> & { wallpaper: Omit<Appearance["wallpaper"], "imageSrc" | "videoSrc">; accentCustom?: AccentColors };

const MEDIA_WORDS: Record<string, string> = { "wallpaper.imageSrc": "the wallpaper picture", "wallpaper.videoSrc": "the wallpaper video", overlayMedia: "the overlays" };

/** The appearance as a theme file, each field named. A picture, video or overlay is a file on this
 *  computer the recipient does not have (an old wallpaper's address even names the home folder),
 *  so each is left out: `leftOut` names those that were set, and `note` says so in words. A key a
 *  newer build wrote stays out too: it is that build's to export. */
export function exportAppearance(a: Appearance, extra?: Pick<AppearanceExtra, "accent"> | null): { theme: ThemeFile; leftOut: string[]; note: string | null } {
  const leftOut = [
    ...(a.wallpaper.imageSrc ? ["wallpaper.imageSrc"] : []),
    ...(a.wallpaper.videoSrc ? ["wallpaper.videoSrc"] : []),
    ...(a.overlayMedia.length > 0 ? ["overlayMedia"] : []),
  ];
  const words = leftOut.map((k) => MEDIA_WORDS[k]!);
  const list = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
  return {
    theme: {
      preset: a.preset, mode: a.mode, palette: a.palette, accent: a.accent, radius: a.radius, uiFont: a.uiFont, monoFont: a.monoFont,
      glass: a.glass, wallpaper: { kind: a.wallpaper.kind, brightness: a.wallpaper.brightness, colour: a.wallpaper.colour }, terminal: a.terminal, pluginSurfaces: a.pluginSurfaces,
      // The custom accent, which wins over `accent` while set; an older build reads the id.
      ...(extra?.accent ? { accentCustom: extra.accent } : {}),
    },
    leftOut,
    note: list ? `Left out ${list}: a theme file holds no media files.` : null,
  };
}

/** The look in a theme file: a bare appearance, or a whole settings.json's `appearance`. */
export function themeFileOf(raw: unknown): Record<string, unknown> {
  const file = isObj(raw) && isObj(raw.appearance) ? raw.appearance : raw;
  return isObj(file) ? file : {};
}

/** The keys of the appearance a theme file names, the only ones `importAppearance` reads. */
export function themeKeysIn(raw: unknown): string[] {
  return Object.keys(themeFileOf(raw)).filter((k) => THEME_KEYS.has(k));
}

/** What importing the theme file `raw` writes, by dotted path, for every writer of an import
 *  (`hive theme import`, the app's Import): each key it names, the memory of the look before,
 *  which an import forgets, and the parts of `appearanceExtra` it speaks to (`importedExtraParts`:
 *  the custom accent, the record of the theme it replaces). Every other key of the appearance
 *  stays as the file has it, a newer build's wallpaper, corners or layers included. */
export function themeImportPaths(raw: unknown): string[] {
  return [
    ...[...themeKeysIn(raw), "lookBefore"].map((k) => `appearance.${k}`),
    ...Object.keys(importedExtraParts(raw)).map((k) => `appearanceExtra.${k}`),
  ];
}

/** A theme file applied over the person's own appearance `cur`: a bare appearance, or a whole
 *  settings.json (its `appearance`). Only the keys this build knows are read from it, checked as
 *  settings are. What it leaves out is kept as `cur` has it, the
 *  media too, so a file of `exportAppearance` never removes yours. A file that sets none of them
 *  (a package.json picked by mistake) is not a theme: it throws, and nothing changes. */
export function importAppearance(raw: unknown, cur: Appearance): Appearance {
  const file = themeFileOf(raw);
  // Anything else in the file (a settings.json's `v` and `views`, a package.json's `name`) is not the look.
  const p = Object.fromEntries(themeKeysIn(raw).map((k) => [k, file[k]]));
  if (Object.keys(p).length === 0) throw new Error(`not a hivemind theme: it sets none of ${[...THEME_KEYS].join(", ")}`);
  const a = mergeAppearance(p, cur);
  const w = isObj(p.wallpaper) ? p.wallpaper : {};
  return {
    ...a,
    wallpaper: { ...a.wallpaper, imageSrc: "imageSrc" in w ? a.wallpaper.imageSrc : cur.wallpaper.imageSrc, videoSrc: "videoSrc" in w ? a.wallpaper.videoSrc : cur.wallpaper.videoSrc },
    overlayMedia: "overlayMedia" in p ? a.overlayMedia : cur.overlayMedia,
  };
}

/** A registered view id: a built-in or folder-installed name, or `@owner/name` from HiveHub. */
const VIEW_ID_RE = /^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{0,63}$/;
/** No toolbar can name more actions than the catalog holds. */
const TOOLBAR_MAX_ACTIONS = 32;

/** A tool plugin installed here: the app's own (`source: "app"`) or one you added, in its package. */
export interface InstalledTool { id: string; source?: "app" | "you"; package?: PackageOf }

/** What the tool registry takes, from the tool plugins' stored state: the plugins switched on,
 *  and the tools switched off inside them (each a plugin option set to false). An installed tool
 *  is on as `isPluginOn` says, its package's switch included. */
export function toolPreferences(s: Pick<Settings, "plugins">, installed: readonly InstalledTool[] = []): ToolsSettings {
  const enabledPlugins = installed.filter((t) => isPluginOn(s.plugins.state, "tool", t, t.source === "app")).map((t) => t.id);
  const disabledTools: string[] = [];
  const isInstalled = new Set(installed.map((t) => t.id));
  for (const [key, st] of Object.entries(s.plugins.state)) {
    if (!key.startsWith("tool:")) continue;
    const id = key.slice(5);
    if (st.enabled === true && !isInstalled.has(id)) enabledPlugins.push(id);
    for (const [tool, v] of Object.entries(st.options ?? {})) if (v === false) disabledTools.push(`${id}/${tool}`);
  }
  return { enabledPlugins, disabledTools };
}

const VIEW_ID = { test: (id: string) => VIEW_ID_RE.test(id), what: "a view's id (lowercase letters, digits and dashes; @owner/name for one from HiveHub)" };
/** Below a plugin's `options`, any field id is a setting, its value checked by the plugin's form. */
const ANY_FIELD = Symbol("any field id");
/** The maps whose keys are ids (a view's, a plugin's): any key in one that such an id can be is a
 *  setting, and below it what one entry holds. Merging drops any other, so it would be set to
 *  nothing. */
// Each entry names every key of its type (`satisfies`), so a key added to the type is settable here.
const ID_MAPS = new Map<string, { test(id: string): boolean; what: string; entry: Record<string, unknown> }>([
  ["views.chrome", { ...VIEW_ID, entry: { island: "top" } satisfies Record<keyof Required<ViewsSettings["chrome"][string]>, unknown> }],
  ["views.toolbars", { ...VIEW_ID, entry: { actions: [], labels: true } satisfies Record<keyof Required<ToolbarPreferences>, unknown> }],
  ["plugins.state", { test: isPluginKey, what: "a plugin's key (kind:id, such as agent:claude)", entry: { enabled: true, options: ANY_FIELD, workspaces: [] } satisfies Record<keyof Required<PluginState>, unknown> }],
]);

/** Sections whose parts are absent until set (`appearanceExtra.accent`). */
const OPTIONAL_PARTS = new Map<string, readonly string[]>([["appearanceExtra", ["accent", "fontFaces", "theme"]]]);

/** Why `hive config set` cannot set the dotted `path`, or null when it is a setting. The file
 *  keeps a key this build does not know (a newer build may have written it), so setting one would
 *  store a value nothing here reads. Inside a map of ids (`views.chrome.<view>`,
 *  `views.toolbars.<view>`, `plugins.state.<plugin>`) any key such an id can be is one, and below
 *  it the keys one entry holds, their values checked as usual. `v` is the file's format, not a
 *  setting. */
export function settingPathProblem(path: string): string | null {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return "name a setting, such as appearance.glass.blur";
  if (keys[0] === "v") return "v is the format of settings.json, which the app keeps; it is not a setting";
  const all = mergeSettings(undefined);
  let at: unknown = all;
  for (let i = 0; i < keys.length; i++) {
    const where = keys.slice(0, i).join(".");
    const ids = ID_MAPS.get(where);
    if (ids) {
      if (!ids.test(keys[i]!)) return `"${keys[i]}" is not ${ids.what}, and ${where} holds only those`;
      at = ids.entry;
      continue;
    }
    if (at === ANY_FIELD) return FIELD_ID.test(keys[i]!) ? (i === keys.length - 1 ? null : `${keys.slice(0, i + 1).join(".")} is one value: set it whole`) : `"${keys[i]}" is not a setting's id (letters, digits, dashes and underscores)`;
    // A part that is absent until set: set it whole.
    const parts = OPTIONAL_PARTS.get(where);
    if (parts?.includes(keys[i]!)) return i === keys.length - 1 ? null : `${keys.slice(0, i + 1).join(".")} is set whole`;
    if (!isObj(at)) return `${where} is ${Array.isArray(at) ? "a list" : "one value"}: set it whole`;
    if (!Object.hasOwn(at, keys[i]!)) {
      const near = settingPaths(all).filter((p) => p.endsWith(`.${keys[i]}`));
      return `this version has no setting ${keys.slice(0, i + 1).join(".")}; ${where || "the file"} holds ${Object.keys(at).join(", ")}${near.length ? `. Did you mean ${near.join(" or ")}?` : ""}`;
    }
    at = at[keys[i]!];
  }
  return null;
}

/** Every dotted path in `o` down to its values. */
function settingPaths(o: unknown, at = ""): string[] {
  if (!isObj(o) || ID_MAPS.has(at)) return [at];
  return Object.entries(o).flatMap(([k, v]) => settingPaths(v, at ? `${at}.${k}` : k));
}

/** Validate + fill a parsed settings.json (any junk) into a Settings.
 *
 *  Two callers share this function: a LOAD (a file just parsed from disk, no base — the
 *  defaults fill the gaps) and a PATCH (a partial object merged onto the settings already in
 *  hand, base given). */
export function mergeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const p = isObj(raw) ? raw : {};
  const views = isObj(p.views) ? p.views : {};
  // Absent `chrome` inherits the base's overrides — a partial merge
  // (`mergeSettings({v:1, appearance}, cur)`) must not wipe every per-view
  // placement the user set. An explicit `{}` still clears them, which is how a
  // "reset to the view defaults" is expressed. (`defaultView` above has always
  // had this fallback; `chrome` silently did not.)
  const chromeIn = isObj(views.chrome) ? views.chrome : base.views.chrome;
  const chrome: ViewsSettings["chrome"] = {};
  for (const [id, v] of Object.entries(chromeIn)) {
    if (!isObj(v) || !VIEW_ID_RE.test(id)) continue;
    const island = ISLAND_PLACEMENTS.includes(v.island as IslandPlacement) ? (v.island as IslandPlacement) : undefined;
    if (island) chrome[id] = { island };
  }
  // Same fallback rule as `chrome`: absent inherits, explicit `{}` clears.
  const toolbarsIn = isObj(views.toolbars) ? views.toolbars : base.views.toolbars;
  const toolbars: ViewsSettings["toolbars"] = {};
  for (const [id, v] of Object.entries(toolbarsIn)) {
    if (!isObj(v) || !VIEW_ID_RE.test(id)) continue;
    const pref: ToolbarPreferences = {};
    // An array — including an EMPTY one — is a real preference and is kept as
    // such; a non-array is a missing preference (the catalog defaults apply).
    if (Array.isArray(v.actions)) {
      const seen = new Set<ToolbarActionId>();
      const actions: ToolbarActionId[] = [];
      for (const a of v.actions) {
        if (!isToolbarActionId(a) || seen.has(a)) continue;
        seen.add(a);
        actions.push(a);
        if (actions.length >= TOOLBAR_MAX_ACTIONS) break;
      }
      pref.actions = actions;
    }
    if (typeof v.labels === "boolean") pref.labels = v.labels; // explicit false survives
    if (pref.actions !== undefined || pref.labels !== undefined) toolbars[id] = pref;
  }
  const plugins = isObj(p.plugins) ? p.plugins : {};
  const agents = isObj(p.agents) ? p.agents : {};
  // Plugin state as stored; else (a partial merge) as `base` has it.
  const state = isObj(plugins.state) ? parsePluginStates(plugins.state) : base.plugins.state;
  const appearance = mergeAppearance(p.appearance, base.appearance);
  // Only what this build reads. What else the file holds (a newer build's keys and values) is
  // the writer's to keep (settings-write.ts), never carried here.
  return {
    v: p.v === undefined ? base.v : settingsVersionOf(p),
    appearance,
    appearanceExtra: appearanceExtraOf(isObj(p.appearanceExtra) ? p.appearanceExtra : base.appearanceExtra, appearance),
    views: { defaultView: str(views.defaultView, base.views.defaultView, 64), chrome, toolbars, layers: mergeLayersPrefs(views.layers, base.views.layers) },
    plugins: { state },
    agents: {
      defaultAgent: str(agents.defaultAgent, base.agents.defaultAgent, 64),
      autoInstall: bool(agents.autoInstall, base.agents.autoInstall),
      declined: (Array.isArray(agents.declined) ? agents.declined : base.agents.declined)
        .filter((x): x is string => typeof x === "string" && AGENT_KEY_RE.test(x)).slice(0, 200),
      fromCatalog: (Array.isArray(agents.fromCatalog) ? agents.fromCatalog : base.agents.fromCatalog)
        .filter((x): x is string => typeof x === "string" && AGENT_KEY_RE.test(x)).slice(0, 200),
      whenAgentStartsAgent: WHEN_AGENT_STARTS_AGENT.includes(agents.whenAgentStartsAgent as WhenAgentStartsAgent)
        ? (agents.whenAgentStartsAgent as WhenAgentStartsAgent) : base.agents.whenAgentStartsAgent,
    },
    profile: profileOf(p.profile, base.profile),
    network: { updateCheck: bool((isObj(p.network) ? p.network : {}).updateCheck, base.network.updateCheck) },
    browserApp: browserAppOf(p.browserApp, base.browserApp),
    quit: { whenRunning: quitChoiceOf((isObj(p.quit) ? p.quit : {}).whenRunning, base.quit.whenRunning) },
    notifications: normalizeNotificationSettings(p.notifications, base.notifications),
  };
}

const quitChoiceOf = (v: unknown, def: QuitChoice): QuitChoice => (QUIT_CHOICES.includes(v as QuitChoice) ? (v as QuitChoice) : def);

const HOST_NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** `name` or `name:port`, a port being 1–65535. */
function isHostAndPort(n: string): boolean {
  const [, name, port] = /^([^:]*)(?::(\d{1,5}))?$/.exec(n) ?? [];
  return name !== undefined && HOST_NAME_RE.test(name) && (port === undefined || (Number(port) >= 1 && Number(port) <= 65535));
}

function browserAppOf(raw: unknown, base: BrowserAppSettings): BrowserAppSettings {
  const p = isObj(raw) ? raw : {};
  const port = typeof p.port === "number" && Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535 ? p.port : base.port;
  const names = Array.isArray(p.names)
    ? [...new Set(p.names.filter((n): n is string => typeof n === "string").map((n) => n.trim().toLowerCase()).filter(isHostAndPort))].slice(0, 8)
    : base.names;
  return { enabled: bool(p.enabled, base.enabled), port, names };
}

/** A profile as others see it, from anything (settings.json, or someone asking to join): its
 *  fields checked, and what does not pass kept as `base` has it. */
export function profileOf(raw: unknown, base: ProfileSettings = DEFAULT_SETTINGS.profile): ProfileSettings {
  const p = isObj(raw) ? raw : {};
  return {
    name: profileName(p.name, base.name),
    color: typeof p.color === "string" && PROFILE_COLOR_RE.test(p.color) ? p.color.toLowerCase() : base.color,
  };
}

/** Empty, to clear it, or a hex colour. */
const PROFILE_COLOR_RE = /^(#[0-9a-fA-F]{6})?$/;

/** A name as others see it: trimmed, at most 64 characters, with no control characters, line
 *  breaks or bidirectional overrides (which would let a name show as something it is not). Empty
 *  clears it; anything else keeps the name before. */
function profileName(v: unknown, def: string): string {
  if (typeof v !== "string") return def;
  const name = v.trim();
  return name.length <= 64 && !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : def;
}

/** An agent's id, which may carry a HiveHub scope — unlike the option ids inside it. */
const AGENT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ── the renderer's flat theme view ──────────────────────────────────────────
// The renderer components (customizer, wallpaper, terminal) read a FLAT shape;
// settings.json keeps the nested one. Two pure moves, round-trip tested.

export interface FlatTheme {
  glass: boolean; blur: number; opacity: number; wallpaper: WallpaperId; accent: AccentId;
  videoSrc?: string; imageSrc?: string; videoBrightness?: number; animate: boolean;
  /** `wallpaper.colour`: a live scene in its own colours. */
  wallpaperColour: boolean;
  contentGlass: boolean; contentOpacity: number; overlayMedia: MediaLayer[];
  preset: string; mode: "dark" | "light"; palette: Palette; radius: number; uiFont: string; monoFont: string;
  terminal: TerminalPalette; pluginSurfaces: "theme" | "opaque"; lookBefore?: LookBefore;
  /** From `appearanceExtra`: the custom accent, which wins over `accent`, and a theme's font
   *  files. Written back there, never into `appearance`. */
  accentCustom?: AccentColors; fontFaces?: FontFaces;
  /** The theme applied (`appearanceExtra.theme`), by id: its wallpaper draws without glass. */
  themeId?: string;
}

export function flattenAppearance(a: Appearance, extra?: Pick<AppearanceExtra, "accent" | "fontFaces" | "theme"> | null): FlatTheme {
  return {
    accentCustom: extra?.accent, fontFaces: extra?.fontFaces, themeId: extra?.theme?.id,
    glass: a.glass.enabled, blur: a.glass.blur, opacity: a.glass.opacity, contentGlass: a.glass.contentGlass, contentOpacity: a.glass.contentOpacity, animate: a.glass.animate,
    wallpaper: a.wallpaper.kind, videoSrc: a.wallpaper.videoSrc, imageSrc: a.wallpaper.imageSrc, videoBrightness: a.wallpaper.brightness, wallpaperColour: a.wallpaper.colour,
    accent: a.accent, overlayMedia: a.overlayMedia,
    preset: a.preset, mode: a.mode, palette: a.palette, radius: a.radius, uiFont: a.uiFont, monoFont: a.monoFont, terminal: a.terminal, pluginSurfaces: a.pluginSurfaces,
    lookBefore: a.lookBefore,
  };
}

/** What a guest paints while a host's workspace is shown: the host's look (`sharedAppearance`),
 *  read in the guest's own fonts. */
export function guestTheme(own: FlatTheme, host: SharedAppearance): FlatTheme {
  // The host's custom accent is a colour; its font files are its own, as its fonts are.
  return { ...flattenAppearance(host, { accent: host.accentCustom }), uiFont: own.uiFont, monoFont: own.monoFont, fontFaces: own.fontFaces };
}

export function nestAppearance(f: FlatTheme): Appearance {
  return {
    preset: f.preset, mode: f.mode, palette: f.palette, accent: f.accent, radius: f.radius, uiFont: f.uiFont, monoFont: f.monoFont,
    glass: { enabled: f.glass, contentGlass: f.contentGlass, opacity: f.opacity, blur: f.blur, contentOpacity: f.contentOpacity, animate: f.animate },
    wallpaper: { kind: f.wallpaper, videoSrc: f.videoSrc, imageSrc: f.imageSrc, brightness: f.videoBrightness ?? DEFAULT_APPEARANCE.wallpaper.brightness, colour: f.wallpaperColour },
    terminal: f.terminal, pluginSurfaces: f.pluginSurfaces, overlayMedia: f.overlayMedia,
    // Always named, undefined too: the store writes the sections that changed, a forgotten one included.
    lookBefore: f.lookBefore,
  };
}

// ── dotted paths (hive config get/set) ──────────────────────────────────────

export function getPath(obj: unknown, path: string): unknown {
  let o: unknown = obj;
  // Own keys only: an inherited `constructor` is not a setting.
  for (const k of path.split(".").filter(Boolean)) { if ((!isObj(o) && !Array.isArray(o)) || !Object.hasOwn(o, k)) return undefined; o = (o as Record<string, unknown>)[k]; }
  return o;
}

/** Immutable set at a dotted path; refuses `__proto__`, the one key that is not data. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return obj;
  if (keys.includes("__proto__")) throw new Error(`refusing to set "${path}"`);
  const rec = (o: unknown, i: number): unknown => {
    const k = keys[i]!;
    const base = isObj(o) ? { ...o } : {};
    base[k] = i === keys.length - 1 ? value : rec(isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined, i + 1);
    return base;
  };
  return rec(obj, 0) as T;
}

/** The Layers View menu from a stored value: each choice kept when it is one of its list, else `base`'s. */
function mergeLayersPrefs(raw: unknown, base: LayersPrefs): LayersPrefs {
  const v = isObj(raw) ? raw : {};
  const pick = <T extends string>(x: unknown, list: readonly T[], fallback: T): T => (list.includes(x as T) ? (x as T) : fallback);
  return {
    status: pick(v.status, LAYERS_STATUS, base.status),
    activity: pick(v.activity, LAYERS_ACTIVITY, base.activity),
    groupBy: pick(v.groupBy, LAYERS_GROUP_BY, base.groupBy),
    sortBy: pick(v.sortBy, LAYERS_SORT_BY, base.sortBy),
    machines: Array.isArray(v.machines)
      ? [...new Set(v.machines.filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 128))].slice(0, 64)
      : base.machines,
    recentsBy: pick(v.recentsBy, LAYERS_RECENTS_BY, base.recentsBy),
    lines: pick(v.lines, LAYERS_LINES, base.lines),
  };
}
