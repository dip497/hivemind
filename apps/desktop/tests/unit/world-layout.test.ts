// The World view's layout blob (v1): island auto-placement on a spiral that
// respects stored spots, tile grid placement, and the versioned spec shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WORLD_LAYOUT, placeIslands, placeTiles, ISLAND_SIZE, ISLAND_GAP } from "../../src/renderer/src/workspace/views/world/world-layout.ts";
import { loadViewLayout, saveViewLayout } from "../../src/renderer/src/workspace/view-layout-store.ts";

const STEP = ISLAND_SIZE + ISLAND_GAP;

test("placeIslands: first frame at the origin, then a spiral; stored spots are kept and skipped", () => {
  const a = placeIslands(["f1", "f2", "f3"], {});
  assert.deepEqual(a.f1, { x: 0, z: 0 });
  assert.notDeepEqual(a.f2, a.f1);
  assert.notDeepEqual(a.f3, a.f2);
  const dist = (p: { x: number; z: number }) => Math.max(Math.abs(p.x), Math.abs(p.z));
  assert.equal(dist(a.f2!), STEP);
  // A stored placement is verbatim, and the spot it occupies is not reused.
  const b = placeIslands(["f1", "f2"], { f2: { x: 0, z: 0 } });
  assert.deepEqual(b.f2, { x: 0, z: 0 });
  assert.notDeepEqual(b.f1, { x: 0, z: 0 });
  // Stable: same inputs → same output.
  assert.deepEqual(placeIslands(["f1", "f2", "f3"], {}), a);
});

test("placeTiles: centred grid, up to 3 per row", () => {
  assert.deepEqual(placeTiles(1), [{ x: 0, z: 0 }]);
  const four = placeTiles(4);
  assert.equal(four.length, 4);
  assert.equal(new Set(four.map((p) => p.z)).size, 2, "two rows");
  assert.equal(four[3]!.x, 0, "a lone tile on the second row is centred");
});

test("WORLD_LAYOUT is v1, starts empty, and round-trips through the view-layout store", () => {
  const store = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
  };
  assert.equal(WORLD_LAYOUT.version, 1);
  assert.deepEqual(loadViewLayout(WORLD_LAYOUT, "/repo"), { camera: null, islands: {} });
  saveViewLayout(WORLD_LAYOUT, "/repo", { camera: { position: [1, 2, 3], target: [0, 0, 0] }, islands: { f1: { x: 14, z: 0 } } });
  assert.deepEqual(loadViewLayout(WORLD_LAYOUT, "/repo").islands, { f1: { x: 14, z: 0 } });
  // An older/unknown version starts fresh (v1 has nothing to migrate from).
  store.set("hivemind:view-layout:world:/repo", JSON.stringify({ v: 0, data: { camera: "x" } }));
  assert.deepEqual(loadViewLayout(WORLD_LAYOUT, "/repo"), { camera: null, islands: {} });
  delete (globalThis as unknown as { window?: unknown }).window;
});
