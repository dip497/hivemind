/**
 * Background-worker registry. A tile spawned by a WORKFLOW (or any HCP spawn with
 * `report:false`) is a programmatic worker the user is gathering in bulk — not a
 * tile they're driving. Such tiles must NOT steal focus / center the viewport on
 * spawn, and must NOT raise a per-worker "finished" toast / OS-notification
 * (N workers → N pings is noise). This tiny module is the cross-cutting marker:
 * the spawn marks the tile, and placeInFrame (focus) + useAgentAwareness
 * (notifications) read it. Keyed by bare tile id.
 */
const backgroundTiles = new Set<string>();

export function markBackgroundTile(tileId: string): void {
  backgroundTiles.add(tileId);
}

export function unmarkBackgroundTile(tileId: string): void {
  backgroundTiles.delete(tileId);
}

export function isBackgroundTile(tileId: string): boolean {
  return backgroundTiles.has(tileId);
}
