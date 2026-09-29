/**
 * What a window kept in localStorage before the store existed, offered once for import
 * (docs/design/multiplayer-2026-09-28.md, R1). The store checks every entry, so a window sends
 * what it found without judging it. Nothing here imports Node or Electron: the window uses it.
 * The layout's own shapes are the workspace document's (`@hivemind/workspace-doc/shapes`).
 */
export interface LegacyLayout {
  core?: unknown;
  views?: Record<string, unknown>;
}
