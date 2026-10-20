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
import { parsePluginStates, pluginStatesFromLegacy, type PluginState } from "./plugin-settings.js";

// ── appearance ────────────────────────────────────────────────────────────────

export type WallpaperId =
  | "none" | "aurora" | "ember" | "ice" | "mesh" | "sunset" | "forest" | "nebula" | "mono" | "image" | "video";
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
  { id: "image",  label: "Photo" },
  { id: "video",  label: "Video" },
];

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
  };
  terminal: TerminalPalette;
  /** Surfaces docked inside a World / community scene: "theme" renders them
   *  exactly as on the canvas (glass + wallpaper clipped to the slot);
   *  "opaque" uses the terminal background. */
  pluginSurfaces: "theme" | "opaque";
  overlayMedia: MediaLayer[];
}

export interface ThemePreset {
  id: string;
  label: string;
  mode: "dark" | "light";
  palette: Palette;
  accent: AccentId;
  terminal: TerminalPalette;
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

export const PRESETS: Record<string, ThemePreset> = {
  signal: SIGNAL,
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
};

export const DEFAULT_APPEARANCE: Appearance = {
  preset: "signal",
  mode: "dark",
  palette: { ...SIGNAL.palette },
  accent: "graphite",
  radius: 12,
  uiFont: "system-ui, sans-serif",
  monoFont: "\"JetBrains Mono\", monospace",
  glass: { enabled: true, contentGlass: false, opacity: 0.72, blur: 18, contentOpacity: 0.25, animate: true },
  wallpaper: { kind: "mono", brightness: 0.85 },
  terminal: { ...SIGNAL.terminal, ansi: [...SIGNAL.terminal.ansi] },
  pluginSurfaces: "theme",
  overlayMedia: [],
};

/** Apply a preset on top of an appearance: palette, terminal, accent, mode, id. */
export function applyPreset(a: Appearance, preset: ThemePreset): Appearance {
  return { ...a, preset: preset.id, mode: preset.mode, palette: { ...preset.palette }, accent: preset.accent, terminal: { ...preset.terminal, ansi: [...preset.terminal.ansi] } };
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
}
export const DEFAULT_LAYERS_PREFS: LayersPrefs = { status: "all", activity: "all", groupBy: "group", sortBy: "canvas", machines: [], recentsBy: "agent" };

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
export interface Settings {
  v: 1;
  appearance: Appearance;
  views: ViewsSettings;
  plugins: PluginsSettings;
  agents: AgentsSettings;
  profile: ProfileSettings;
  network: NetworkSettings;
  browserApp: BrowserAppSettings;
  quit: QuitSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  appearance: DEFAULT_APPEARANCE,
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
  return {
    preset,
    mode: p.mode === "light" ? "light" : "dark",
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
    },
    terminal: {
      background: color(t.background, base.terminal.background),
      foreground: color(t.foreground, base.terminal.foreground),
      cursor: color(t.cursor, base.terminal.cursor),
      selection: color(t.selection, base.terminal.selection),
      ansi,
    },
    pluginSurfaces: p.pluginSurfaces === "opaque" ? "opaque" : "theme",
    overlayMedia: (Array.isArray(p.overlayMedia) ? p.overlayMedia : []).map(mediaLayer).filter((m): m is MediaLayer => !!m),
  };
}

/** A host's look as a guest shows it, from anything (a peer's message is untrusted): checked as
 *  settings are, with nothing that names a file on the host's disk. A picture or video wallpaper
 *  becomes the default one, and overlays go: their media is the host's alone. Fonts are not the
 *  look: a guest reads in their own, so the host's are not sent. */
export function sharedAppearance(raw: unknown): Appearance {
  const a = mergeAppearance(raw);
  const media = a.wallpaper.kind === "image" || a.wallpaper.kind === "video";
  return {
    ...a,
    uiFont: DEFAULT_APPEARANCE.uiFont,
    monoFont: DEFAULT_APPEARANCE.monoFont,
    wallpaper: { kind: media ? DEFAULT_APPEARANCE.wallpaper.kind : a.wallpaper.kind, brightness: a.wallpaper.brightness },
    overlayMedia: [],
  };
}

/** A registered view id: a built-in or folder-installed name, or `@owner/name` from HiveHub. */
const VIEW_ID_RE = /^(?!.*--)(?:@[a-z0-9][a-z0-9-]{0,38}\/)?[a-z0-9][a-z0-9-]{0,63}$/;
/** No toolbar can name more actions than the catalog holds. */
const TOOLBAR_MAX_ACTIONS = 32;

/** Validate + fill a parsed settings.json (any junk) into a Settings.
 *
 *  Two callers share this function: a LOAD (a file just parsed from disk, no base — the
 *  defaults fill the gaps) and a PATCH (a partial object merged onto the settings already in
 *  hand, base given). */
/** Whether a settings.json holds plugin state in the keys a version before `plugins.state` used. */
export function hasLegacyPluginKeys(p: Record<string, unknown>): boolean {
  const has = (o: unknown, k: string) => isObj(o) && o[k] !== undefined;
  return has(p.agents, "disabled") || has(p.agents, "options") || has(p.plugins, "disabled") || isObj(p.tools);
}

/** What the tool registry takes, from the tool plugins' stored state: the plugins switched on,
 *  and the tools switched off inside them (each a plugin option set to false). */
export function toolPreferences(s: Pick<Settings, "plugins">): ToolsSettings {
  const enabledPlugins: string[] = [];
  const disabledTools: string[] = [];
  for (const [key, st] of Object.entries(s.plugins.state)) {
    if (!key.startsWith("tool:")) continue;
    const id = key.slice(5);
    if (st.enabled === true) enabledPlugins.push(id);
    for (const [tool, v] of Object.entries(st.options ?? {})) if (v === false) disabledTools.push(`${id}/${tool}`);
  }
  return { enabledPlugins, disabledTools };
}

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
  // Plugin state as stored; else, from a settings.json written before it, made from the keys
  // that held it then; else (a partial merge) as `base` has it.
  const state = isObj(plugins.state) ? parsePluginStates(plugins.state)
    : hasLegacyPluginKeys(p) ? pluginStatesFromLegacy(p)
    : base.plugins.state;
  return {
    v: 1,
    appearance: mergeAppearance(p.appearance, base.appearance),
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
  contentGlass: boolean; contentOpacity: number; overlayMedia: MediaLayer[];
  preset: string; mode: "dark" | "light"; palette: Palette; radius: number; uiFont: string; monoFont: string;
  terminal: TerminalPalette; pluginSurfaces: "theme" | "opaque";
}

export function flattenAppearance(a: Appearance): FlatTheme {
  return {
    glass: a.glass.enabled, blur: a.glass.blur, opacity: a.glass.opacity, contentGlass: a.glass.contentGlass, contentOpacity: a.glass.contentOpacity, animate: a.glass.animate,
    wallpaper: a.wallpaper.kind, videoSrc: a.wallpaper.videoSrc, imageSrc: a.wallpaper.imageSrc, videoBrightness: a.wallpaper.brightness,
    accent: a.accent, overlayMedia: a.overlayMedia,
    preset: a.preset, mode: a.mode, palette: a.palette, radius: a.radius, uiFont: a.uiFont, monoFont: a.monoFont, terminal: a.terminal, pluginSurfaces: a.pluginSurfaces,
  };
}

/** What a guest paints while a host's workspace is shown: the host's look (`sharedAppearance`),
 *  read in the guest's own fonts. */
export function guestTheme(own: FlatTheme, host: Appearance): FlatTheme {
  return { ...flattenAppearance(host), uiFont: own.uiFont, monoFont: own.monoFont };
}

export function nestAppearance(f: FlatTheme): Appearance {
  return {
    preset: f.preset, mode: f.mode, palette: f.palette, accent: f.accent, radius: f.radius, uiFont: f.uiFont, monoFont: f.monoFont,
    glass: { enabled: f.glass, contentGlass: f.contentGlass, opacity: f.opacity, blur: f.blur, contentOpacity: f.contentOpacity, animate: f.animate },
    wallpaper: { kind: f.wallpaper, videoSrc: f.videoSrc, imageSrc: f.imageSrc, brightness: f.videoBrightness ?? DEFAULT_APPEARANCE.wallpaper.brightness },
    terminal: f.terminal, pluginSurfaces: f.pluginSurfaces, overlayMedia: f.overlayMedia,
  };
}

// ── dotted paths (hive config get/set) ──────────────────────────────────────

export function getPath(obj: unknown, path: string): unknown {
  let o: unknown = obj;
  for (const k of path.split(".").filter(Boolean)) { if (!isObj(o) && !Array.isArray(o)) return undefined; o = (o as Record<string, unknown>)[k]; }
  return o;
}

/** Immutable set at a dotted path; refuses prototype keys. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".").filter(Boolean);
  if (keys.length === 0) return obj;
  if (keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) throw new Error(`refusing to set "${path}"`);
  const rec = (o: unknown, i: number): unknown => {
    const k = keys[i]!;
    const base = isObj(o) ? { ...o } : {};
    base[k] = i === keys.length - 1 ? value : rec(isObj(o) ? o[k] : undefined, i + 1);
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
  };
}
