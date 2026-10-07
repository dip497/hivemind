/**
 * The contract a tool plugin's tiles are drawn by. A tool plugin is an ES module the app loads
 * into itself, so it shares the app's React and its parts; it imports them from the host:
 *
 *   import { useState } from "hm-plugin://host/react.js";
 *   import { jsx } from "hm-plugin://host/react-jsx-runtime.js";
 *   import { Button, PatchView } from "hm-plugin://host/sdk.js";
 *
 * (A plugin built with a bundler marks `react`, `react/jsx-runtime` and `@hivemind/tile-sdk`
 * external and maps them to those URLs.) Its default export says which component draws each tile
 * kind its `hivemind-tool.json` lists:
 *
 *   export default { tiles: { "acme-prs": PullRequests } } satisfies ToolModule;
 *
 * A plugin reaches the app only through what its tile is handed (`TileProps`), never through
 * `window.hive`, which is the app's own and changes without notice:
 *
 *   - `hm`: the same client a view has (`@hivemind/view-sdk`): the workspace's frames, tiles and
 *     names, agents' status, events, commands and requests, each held to the `permissions` its
 *     manifest declares, the `settings` it declares as the person set them, and its saved state
 *     (`hm.hello.layout`, `hm.setLayout`), kept per tile;
 *   - `host`: what only a tile has: its folder, programs run there, and opening things beside it.
 *
 * This contract changes only with `TILE_API_VERSION`, which a plugin names as `apiVersion`.
 */
import type { ViewClient } from "@hivemind/view-sdk";

export const TILE_API_VERSION = 1;

/** The host's modules a plugin imports, by the URL it imports them from. */
export const HOST_MODULES = {
  react: "hm-plugin://host/react.js",
  "react/jsx-runtime": "hm-plugin://host/react-jsx-runtime.js",
  "@hivemind/tile-sdk": "hm-plugin://host/sdk.js",
} as const;

export interface TileInfo {
  id: string;
  /** Its kind, as the plugin's manifest names it. */
  kind: string;
  /** What the person calls it. */
  name: string;
  /** The frame it is in; null when it is loose on the board. */
  frameId: string | null;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TileHost {
  /** The repository the tile works in; null when its frame has none. */
  repoPath: string | null;
  /** The folder its programs run in: the repository, else the workspace's. */
  cwd: string;
  /**
   * Run a program found on PATH, in `cwd`, without a shell: `args` reach it as they are. It
   * resolves with how it ended; it rejects only when it could not start. `maxAgeMs` shares one
   * answer that young between tiles asking the same thing (for reads, never for writes).
   */
  run(bin: string, args: string[], opts?: { maxAgeMs?: number; stdin?: string }): Promise<RunResult>;
  /** Open a file of the repository in its editor, beside this tile. */
  openFile(path: string): void;
  /** Open a web page in the frame's browser. */
  openUrl(url: string): void;
}

export interface TileProps {
  tile: TileInfo;
  hm: ViewClient;
  host: TileHost;
  /** It has the person's focus. */
  selected: boolean;
}

/** A component of the app's React; typed loosely so this package needs no React types. */
export type TileComponent = (props: TileProps) => unknown;

export interface ToolModule {
  /** The component drawing each tile kind the manifest lists, by kind. */
  tiles: Record<string, TileComponent>;
}

/** What `hm-plugin://host/sdk.js` gives a plugin, beside this contract. */
export interface HostSdk {
  TILE_API_VERSION: number;
  /** The app's button: `variant` "default" | "outline" | "ghost" | "destructive", `size` "xs" | "sm" | "default". */
  Button: (props: Record<string, unknown>) => unknown;
  /** A unified diff (`git diff`, `gh pr diff`) drawn as the app draws its own. */
  PatchView: (props: { patch: string; className?: string }) => unknown;
  /** Markdown, drawn safely (no raw HTML). */
  Markdown: (props: { text: string; className?: string }) => unknown;
  /** A spinner in the middle of the space it fills, with what it waits for ("Loading" when unsaid). */
  Loading: (props: { label?: string; className?: string }) => unknown;
  /** `useState` kept with the tile: the value is saved under `key` in the tile's own state
   *  (`hm.setLayout`) and is there again when the app starts. Keys of one tile are kept together. */
  useTileState: <T>(hm: unknown, key: string, initial: T) => [T, (value: T) => void];
}

/** Check a module a plugin's entry exported; why it is not one, or null. */
export function toolModuleProblem(mod: unknown, kinds: readonly string[]): string | null {
  const m = (mod as { default?: unknown } | null)?.default;
  if (!m || typeof m !== "object") return "its module has no default export";
  const tiles = (m as { tiles?: unknown }).tiles;
  if (!tiles || typeof tiles !== "object") return "its default export has no tiles";
  for (const k of kinds) {
    if (typeof (tiles as Record<string, unknown>)[k] !== "function") return `it draws no tile "${k}"`;
  }
  return null;
}
