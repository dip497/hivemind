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

import { BROWSER_PLUGIN_ID } from "./tool-plugins.js";
import { isToolbarActionId, type ToolbarActionId, type ToolbarPreferences } from "./toolbar.js";

// ── appearance ────────────────────────────────────────────────────────────────

export type WallpaperId =
  | "none" | "aurora" | "ember" | "ice" | "mesh" | "sunset" | "forest" | "nebula" | "mono" | "image" | "video";
export type AccentId =
  | "indigo" | "volt" | "ember" | "ice" | "pulse" | "rose" | "emerald" | "amber" | "violet";
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

/** Accent → brand/accent hex. `indigo` is the historical default. */
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

export const PRESETS: Record<string, ThemePreset> = {
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
  preset: "ubuntu",
  mode: "dark",
  palette: { ...UBUNTU.palette },
  accent: "indigo",
  radius: 12,
  uiFont: "system-ui, sans-serif",
  monoFont: "\"JetBrains Mono\", monospace",
  glass: { enabled: true, contentGlass: false, opacity: 0.72, blur: 18, contentOpacity: 0.25, animate: true },
  wallpaper: { kind: "aurora", brightness: 0.85 },
  terminal: { ...UBUNTU.terminal, ansi: [...UBUNTU.terminal.ansi] },
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
}
export interface PluginsSettings {
  /** Community view ids the user switched off (still installed). */
  disabled: string[];
}
export interface ToolsSettings {
  /** Tool plugins the user switched ON. Installation alone activates nothing:
   *  an empty list means every managed tool (the Browser tile) is unavailable. */
  enabledPlugins: string[];
  /** Individual tool ids switched off inside an enabled plugin. */
  disabledTools: string[];
}
export interface AgentsSettings {
  defaultAgent: string;
  model: string;
  permissionMode: string;
}
export interface Settings {
  v: 1;
  appearance: Appearance;
  views: ViewsSettings;
  plugins: PluginsSettings;
  tools: ToolsSettings;
  agents: AgentsSettings;
  /** Set once the renderer's pre-2.0 localStorage keys were imported. */
  migrated: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  appearance: DEFAULT_APPEARANCE,
  views: { defaultView: "canvas", chrome: {}, toolbars: {} },
  plugins: { disabled: [] },
  // Fresh install: no tool plugin is on. A file that predates this section is
  // migrated in mergeSettings so an existing user keeps their Browser tile.
  tools: { enabledPlugins: [], disabledTools: [] },
  // Empty = "the agent catalog's default" — hive-core does not depend on
  // @hivemind/agents, and the renderer resolves an unknown id to defaultAgent().
  agents: { defaultAgent: "", model: "default", permissionMode: "default" },
  migrated: false,
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

/** A registered view id (canvas, windows, world, a community plugin id). */
const VIEW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** No toolbar can name more actions than the catalog holds. */
const TOOLBAR_MAX_ACTIONS = 32;

/** Plugin id (`org/name`) and tool id (`org/name/tool`) shapes, matching
 *  tool-registry's own validation. Anything else is dropped rather than stored. */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}$/;
const TOOL_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{1,39}\/[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate + dedupe + bound a list of namespaced ids, order preserved. */
function idList(raw: unknown, re: RegExp, fallback: readonly string[], max = 200): string[] {
  const src = Array.isArray(raw) ? raw : fallback;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of src) {
    if (typeof v !== "string" || !re.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

/** A settings FILE written before the `tools` section existed. Such a user had
 *  the Browser tile unconditionally, so leaving them with a disabled plugin
 *  would silently remove a tool they use: they get `hivemind/web` enabled. A
 *  MISSING file is not this case — a fresh install starts with everything off.
 *
 *  `isLoad` is the whole safety of this: a PATCH (`mergeSettings(partial, cur)`)
 *  also carries `v: 1` and usually no `tools` key, and treating that as a legacy
 *  file would re-enable the Browser every time a user who had switched it OFF
 *  changed anything else. A load is identified by its base being the defaults —
 *  patches always pass the settings they are patching. */
function migratedTools(raw: Record<string, unknown>, isLoad: boolean): ToolsSettings | null {
  if (!isLoad || raw.v !== 1 || "tools" in raw) return null;
  return { enabledPlugins: [BROWSER_PLUGIN_ID], disabledTools: [] };
}

/** Validate + fill a parsed settings.json (any version, any junk) into a Settings.
 *
 *  Two callers with different meanings share this function: a LOAD (a file just
 *  parsed from disk, no base — the defaults fill the gaps) and a PATCH (a partial
 *  object merged onto the settings already in hand, base given). Only a load may
 *  run the pre-`tools` migration; see `migratedTools`. */
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
  const toolsIn = isObj(p.tools) ? p.tools : {};
  const tools = migratedTools(p, base === DEFAULT_SETTINGS) ?? {
    enabledPlugins: idList(toolsIn.enabledPlugins, PLUGIN_ID_RE, base.tools.enabledPlugins),
    disabledTools: idList(toolsIn.disabledTools, TOOL_ID_RE, base.tools.disabledTools),
  };
  return {
    v: 1,
    appearance: mergeAppearance(p.appearance, base.appearance),
    views: { defaultView: str(views.defaultView, base.views.defaultView, 64), chrome, toolbars },
    plugins: { disabled: (Array.isArray(plugins.disabled) ? plugins.disabled : base.plugins.disabled).filter((x): x is string => typeof x === "string").slice(0, 200) },
    tools,
    agents: {
      defaultAgent: str(agents.defaultAgent, base.agents.defaultAgent, 64),
      model: str(agents.model, base.agents.model, 128),
      permissionMode: str(agents.permissionMode, base.agents.permissionMode, 64),
    },
    migrated: bool(p.migrated, base.migrated),
  };
}

// ── pre-2.0 localStorage → settings ─────────────────────────────────────────

/** The renderer's old flat theme blob (`hivemind:theme`) + the other keys it
 *  kept. Everything optional; unknown fields are ignored. */
export interface LegacyRendererState {
  theme?: unknown;
  viewMode?: string | null;
  agentSel?: string | null;
  claudeMode?: string | null;
  claudeModel?: string | null;
}

export function migrateLegacy(legacy: LegacyRendererState, base: Settings = DEFAULT_SETTINGS): Settings {
  const t = isObj(legacy.theme) ? legacy.theme : {};
  const appearance = mergeAppearance({
    glass: { enabled: t.glass, contentGlass: t.contentGlass, opacity: t.opacity, blur: t.blur, contentOpacity: t.contentOpacity, animate: t.animate },
    wallpaper: { kind: t.wallpaper, videoSrc: t.videoSrc, imageSrc: t.imageSrc, brightness: t.videoBrightness },
    accent: t.accent,
    overlayMedia: Array.isArray(t.overlayMedia) ? t.overlayMedia : isObj(t.overlayMedia) ? [t.overlayMedia] : [],
  }, base.appearance);
  return mergeSettings({
    ...base,
    appearance,
    views: { ...base.views, defaultView: legacy.viewMode ?? base.views.defaultView },
    agents: {
      defaultAgent: legacy.agentSel ?? base.agents.defaultAgent,
      model: legacy.claudeModel ?? base.agents.model,
      permissionMode: legacy.claudeMode ?? base.agents.permissionMode,
    },
    migrated: true,
  }, base);
}

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
