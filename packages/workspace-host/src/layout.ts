/**
 * The shapes a workspace's layout travels in, shared by the store and every client
 * (docs/design/multiplayer-2026-09-28.md, R1). Nothing here imports Node or Electron: the
 * window uses these types and the guard too.
 */

/** A view's layout: the view's own schema version and its data. */
export interface ViewLayout {
  v: number;
  data: unknown;
}

/**
 * What a window kept in localStorage before the store existed, offered once for import. The
 * store checks every entry, so a window sends what it found without judging it.
 */
export interface LegacyLayout {
  core?: unknown;
  views?: Record<string, unknown>;
}

export function isViewLayout(x: unknown): x is ViewLayout {
  return typeof x === "object" && x !== null && !Array.isArray(x)
    && typeof (x as ViewLayout).v === "number" && Number.isFinite((x as ViewLayout).v)
    && "data" in x;
}
