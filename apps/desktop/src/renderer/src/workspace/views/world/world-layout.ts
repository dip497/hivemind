/**
 * world-layout — the World view's persisted navigation state: the camera pose
 * and where each frame's island sits on the ground plane. Versioned per-repo
 * blob (`hivemind:view-layout:world:<repo>`), v1. Pure: the placement rules
 * here are what the unit tests pin.
 */
import type { ViewLayoutSpec } from "../../view-layout-store";

export interface WorldCamera {
  position: [number, number, number];
  target: [number, number, number];
}

export interface WorldLayout {
  camera: WorldCamera | null;
  /** frame id → island centre on the ground plane. Absent = auto-placed. */
  islands: Record<string, { x: number; z: number }>;
}

export const WORLD_LAYOUT: ViewLayoutSpec<WorldLayout> = {
  viewId: "world",
  version: 1,
  initial: () => ({ camera: null, islands: {} }),
  // v1 is the first version; an unknown older blob starts fresh.
  migrate: () => null,
};

/** Island spacing on the ground plane (world units; an island is ~ISLAND_SIZE across). */
export const ISLAND_SIZE = 10;
export const ISLAND_GAP = 4;

/** Auto-place islands that have no stored spot on a square spiral around the
 *  origin, skipping spots already taken by stored placements, in a stable
 *  order (the frames' order). Returns a COMPLETE map — stored spots verbatim,
 *  the rest filled in — so the scene never needs a second source of truth. */
export function placeIslands(frameIds: readonly string[], stored: WorldLayout["islands"]): Record<string, { x: number; z: number }> {
  const out: Record<string, { x: number; z: number }> = {};
  const taken = new Set<string>();
  const key = (x: number, z: number) => `${x},${z}`;
  for (const id of frameIds) {
    const p = stored[id];
    if (p) { out[id] = { x: p.x, z: p.z }; taken.add(key(Math.round(p.x), Math.round(p.z))); }
  }
  const step = ISLAND_SIZE + ISLAND_GAP;
  // Square spiral: (0,0), then rings of increasing radius.
  const spots: Array<[number, number]> = [[0, 0]];
  for (let r = 1; r < 32; r++) {
    for (let x = -r; x <= r; x++) spots.push([x, -r], [x, r]);
    for (let z = -r + 1; z <= r - 1; z++) spots.push([-r, z], [r, z]);
  }
  let i = 0;
  for (const id of frameIds) {
    if (out[id]) continue;
    while (i < spots.length && taken.has(key(spots[i]![0] * step, spots[i]![1] * step))) i++;
    const [gx, gz] = spots[i] ?? [0, 0];
    out[id] = { x: gx * step, z: gz * step };
    taken.add(key(gx * step, gz * step));
    i++;
  }
  return out;
}

/** Grid positions for a frame's tiles on its island (local to the island
 *  centre): up to `cols` per row, centred. */
export function placeTiles(count: number, cols = 3, spacing = 2.4): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const rows = Math.max(1, Math.ceil(count / cols));
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const rowCount = Math.min(cols, count - r * cols);
    out.push({ x: (c - (rowCount - 1) / 2) * spacing, z: (r - (rows - 1) / 2) * spacing });
  }
  return out;
}
