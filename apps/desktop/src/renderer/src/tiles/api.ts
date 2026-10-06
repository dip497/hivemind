/**
 * Tile plugins: everything a tile is — its size, its rules and its body — comes from the plugin
 * that registers its kind. The tiles that ship with the app register through this same API.
 */
import type { ComponentType } from "react";
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
  /** Text rasterized crisply only at 1:1, so focusing it snaps to 100%. */
  pixelExact?: boolean;
}

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
  /** Loaded the first time a tile of this plugin is shown. */
  body: () => Promise<{ default: ComponentType<TileBodyArgs<D>> }>;
  /** Shown while the body loads. */
  fallback?: ComponentType;
  /** Mount even when no view shows it, so what it runs keeps running. */
  runsUnseen?: boolean;
}

const bySurface = new Map<string, TilePlugin>();
const byKind = new Map<string, { plugin: TilePlugin; spec: TileKindSpec }>();

export function registerTile<D>(plugin: TilePlugin<D>): void {
  const p = plugin as TilePlugin;
  for (const kind of Object.keys(p.kinds)) {
    const taken = byKind.get(kind);
    if (taken && taken.plugin !== p) throw new Error(`tile kind "${kind}" is already drawn by "${taken.plugin.surface}"`);
  }
  bySurface.set(p.surface, p);
  for (const [kind, spec] of Object.entries(p.kinds)) byKind.set(kind, { plugin: p, spec });
}

export const tilePlugin = (surface: string): TilePlugin | undefined => bySurface.get(surface);
export const pluginOfKind = (kind: string): TilePlugin | undefined => byKind.get(kind)?.plugin;

const UNKNOWN: TileKindSpec = { size: { width: 1200, height: 820 } };
/** A kind no installed plugin draws still has a box, so a board that names one still loads. */
export const tileKind = (kind: string): TileKindSpec => byKind.get(kind)?.spec ?? UNKNOWN;
