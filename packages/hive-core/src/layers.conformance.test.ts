/**
 * The View menu's rules held to conformance/layers.json, which the phone's core
 * (crates/hive-phone/tests/layers.rs) reads too: the same tiles and choices give the same lists.
 */
process.env.TZ = "UTC";
import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { layersView, type ModelTile } from "./layers.js";
import { DEFAULT_LAYERS_PREFS, type LayersPrefs } from "./settings-schema.js";

const file = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../conformance/layers.json"), "utf8")) as {
  now: number;
  tiles: Array<Omit<ModelTile, "kind">>;
  label: Record<string, string>;
  cases: Array<{ about: string; prefs: Partial<LayersPrefs>; pinned?: string[]; query?: string; shows: unknown }>;
};
const tiles: ModelTile[] = file.tiles.map((t) => ({ kind: "claude", ...t }));

for (const c of file.cases) {
  test(`layers: ${c.about}`, () => {
    const v = layersView({ tiles, pinned: c.pinned ?? [], prefs: { ...DEFAULT_LAYERS_PREFS, ...c.prefs }, now: file.now, agentLabel: (t) => file.label[t.id]!, query: c.query });
    const ids = (l: ModelTile[]) => l.map((t) => t.id);
    assert.deepEqual({
      pinned: ids(v.pinned), tree: v.tree,
      byFrame: [...v.byFrame].map(([f, l]) => [f, ids(l)]),
      buckets: v.buckets.map((b) => ({ key: b.key, label: b.label, tiles: ids(b.tiles) })),
      filtering: v.filtering,
      kids: [...v.kids].map(([p, l]) => [p, ids(l)]),
    }, c.shows);
  });
}
