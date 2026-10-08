/**
 * Tile plugins: everything a tile is — its size, its rules and its body — comes from the plugin
 * that registers its kind. The tiles that ship with the app register through this same API.
 */
import { PLUGIN_CATEGORIES, type PluginCategory } from "@hivemind/view-sdk/category";
import { useSyncExternalStore, type ComponentType } from "react";
/** A kind's icon: a lucide icon, or a plugin's drawn the same way. */
export type KindIcon = ComponentType<{ size?: number; className?: string }>;
import type { TileInstance } from "../canvas-persistence";

/** Screen-space rect captured from a tile's DOM at pin time (SCREEN pixels). */
export type PinRect = { sx: number; sy: number; w: number; h: number };

/** Where a tile runs: its frame's zone when it has one, else the workspace. */
export interface TileScope {
  /** The repo it runs in, or null when there is none. */
  repoPath: string | null;
  cwd: string;
  /** The `.hivemind` root its issues live in. */
  root: string | null;
  /** The frame's own repo (a worktree or a bound folder), when it has one. */
  zoneRepo: string | null;
  frameId: string | null;
  pin: { pinned: boolean; onTogglePin: (id: string, rect: PinRect) => void };
  onClose: () => void;
}

/** What the workspace offers every tile. */
export interface TileHostState {
  editorTabs: Record<string, string[]>;
  browserOpenReqs: Record<string, { url: string; seq: number }>;
  tileNames: Record<string, string>;
  agentTitles: Record<string, string>;
  openFileInTile: (tileId: string, file: string) => void;
  openUrlInBrowser: (sourceTileId: string, url: string) => void;
  openFileFromTerminal: (sourceTileId: string, path: string) => void;
  closeTabInTile: (tileId: string, file: string) => void;
  renameTile: (id: string, name: string) => void;
}

export interface TileKindSpec {
  size: { width: number; height: number };
  /** Name a fresh tile gets. */
  label?: string;
  /** Has no body without a repo. */
  needsRepo?: boolean;
  /** One per frame: spawning again focuses the existing one. */
  singleton?: boolean;
  /** A kind a board saved before, drawn as this other kind and counted as it. */
  sameAs?: string;
  /** Text rasterized crisply only at 1:1, so focusing it snaps to 100%. */
  pixelExact?: boolean;
  /** The camera lands on whole pixels when it flies to it. */
  wholePixels?: boolean;
  /** What a person calls it, in menus that open one. Absent: it is not opened from a menu. */
  title?: string;
  /** What it is for: the Add menu groups what it offers by it. */
  category?: PluginCategory;
  /** Its mark in tab strips and the Layers panel: an icon, or a monochrome glyph. */
  icon?: KindIcon;
  glyph?: string;
  /** What another tile can hand it: a path to open, a page to show. */
  opens?: readonly TileIntent[];
  /** Exists only while something waits on it, so a saved layout leaves it out. */
  ephemeral?: boolean;
  /** Has no pin in its header. */
  unpinnable?: boolean;
  /** Its existence means someone is waiting on the person. */
  waitsOnPerson?: boolean;
  /** The fields a fresh tile starts with. `ordinal` numbers it among its kind ("shell #2"). */
  create?: (opts: TileCreateOpts, ordinal: (name: (n: number) => string) => string) => TileStart;
}

export type TileIntent = "file" | "url";
export interface TileCreateOpts { url?: string; session?: { id: string; cmd: string; args?: string[]; label: string } }
export type TileStart = Pick<TileInstance, "label"> & Partial<Pick<TileInstance, "cmd" | "args" | "url" | "session">>;

export interface TileBodyArgs<D> { data: D; selected: boolean }

export interface TilePlugin<D = unknown> {
  /** The body's id: the canvas node type and its `.react-flow__node-<surface>` hook. */
  surface: string;
  /** Shown when the body throws. */
  name: string;
  /** The saved kinds this plugin draws. */
  kinds: Record<string, TileKindSpec>;
  /** The body's props for one tile, or null when it has nothing to show. */
  data: (tile: TileInstance, scope: TileScope, host: TileHostState) => D | null;
  /** The body: ready now, or loaded the first time a tile of this plugin is shown. */
  body: ComponentType<TileBodyArgs<D>> | (() => Promise<{ default: ComponentType<TileBodyArgs<D>> }>);
  /** `body` is the loader, not the component. */
  lazy?: boolean;
  /** Shown while the body loads. */
  fallback?: ComponentType;
  /** Mount even when no view shows it, so what it runs keeps running. */
  runsUnseen?: boolean;
  /** The smallest a person can resize it to. */
  minSize?: { width?: number; height?: number };
}

const bySurface = new Map<string, TilePlugin>();
const byKind = new Map<string, { plugin: TilePlugin; spec: TileKindSpec }>();
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** Bumps whenever a plugin registers, so what was drawn without it is drawn again. */
export const useTilesVersion = (): number => useSyncExternalStore(subscribe, () => version);

export function registerTile<D>(plugin: TilePlugin<D>): void {
  const p = plugin as TilePlugin;
  for (const kind of Object.keys(p.kinds)) {
    const taken = byKind.get(kind);
    if (taken && taken.plugin !== p) throw new Error(`tile kind "${kind}" is already drawn by "${taken.plugin.surface}"`);
  }
  bySurface.set(p.surface, p);
  for (const [kind, spec] of Object.entries(p.kinds)) byKind.set(kind, { plugin: p, spec });
  version++;
  for (const fn of listeners) fn();
}

/** Take a plugin's kinds away again (switched off, removed): a tile of them shows the missing card. */
export function unregisterTile(surface: string): void {
  const p = bySurface.get(surface);
  if (!p) return;
  bySurface.delete(surface);
  for (const [kind, v] of byKind) if (v.plugin === p) byKind.delete(kind);
  version++;
  for (const fn of listeners) fn();
}

/** Whether a plugin may start a tile of `kind`: one an installed plugin draws, that is not opened
 *  only by something waiting on the person. */
export const canSpawnKind = (kind: string): boolean => {
  const k = byKind.get(kind);
  return !!k && !k.spec.ephemeral && !k.spec.sameAs;
};

/** Every installed plugin's surface. */
export const tileSurfaces = (): string[] => [...bySurface.keys()];

export const tilePlugin = (surface: string): TilePlugin | undefined => bySurface.get(surface);
/** The plugin that draws a kind; a kind nothing installed draws gets the missing-plugin card,
 *  so a guest without it, or a phone, sees what the tile is instead of nothing. */
export const pluginOfKind = (kind: string): TilePlugin | undefined => byKind.get(kind)?.plugin ?? bySurface.get(MISSING);
export const MISSING = "missing";

/** Every kind installed, in the order its plugin registered. */
export const tileKinds = (): [string, TileKindSpec][] => [...byKind].map(([kind, { spec }]) => [kind, spec]);

/** The kinds a person opens by name (Add ▸ Tools, a frame's Open ▸): every one with a title, by
 *  category in the catalogue's order, then by name. None comes first for having shipped with the app. */
export const toolKinds = (): [string, TileKindSpec][] =>
  tileKinds().filter(([, spec]) => spec.title).sort(([, a], [, b]) =>
    (PLUGIN_CATEGORIES.indexOf(a.category ?? "other") - PLUGIN_CATEGORIES.indexOf(b.category ?? "other")) || a.title!.localeCompare(b.title!));

/** The kinds that take what another tile hands over, first registered first. */
export const kindsThatOpen = (intent: TileIntent): string[] =>
  tileKinds().filter(([, spec]) => spec.opens?.includes(intent)).map(([kind]) => kind);

const UNKNOWN: TileKindSpec = { size: { width: 1200, height: 820 } };
/** A kind no installed plugin draws still has a box, so a board that names one still loads. */
export const tileKind = (kind: string): TileKindSpec => byKind.get(kind)?.spec ?? UNKNOWN;
