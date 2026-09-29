/**
 * What the store shares with a window (docs/design/multiplayer-2026-09-28.md, R1, R5): the layout
 * a window kept in localStorage before the store existed, offered once for import, and what a
 * change to a workspace says. The store checks every entry, so a window sends what it found
 * without judging it. Nothing here imports Node or Electron: the window uses it. The layout's own
 * shapes are the workspace document's (`@hivemind/workspace-doc/shapes`).
 */
export interface LegacyLayout {
  core?: unknown;
  views?: Record<string, unknown>;
}

/** A change to a workspace, and who made it. */
export interface WorkspaceChange {
  repo: string;
  /** What changed: the core layout, the board, or one view's layout. */
  part: "core" | "board" | `view:${string}`;
  /** Whoever wrote it said so (a window, the control plane); "" when it did not. */
  writer: string;
}
