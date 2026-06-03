// The canvas layout persistence + legacy migrations — now unit-testable since
// loadLayout/saveLayout are pure module functions (no React). A tiny in-memory
// localStorage shim stands in for the browser store.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Shim window.localStorage BEFORE importing the module (its module-load cleanup
// + load/save read window at call time).
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { loadLayout, saveLayout, LAYOUT_KEY, WORKBENCH_TILE_ID } = await import(
  "../../src/renderer/src/canvas-persistence.ts"
);

beforeEach(() => store.clear());

test("no repo → empty layout, never reads/writes storage", () => {
  const l = loadLayout(null);
  assert.deepEqual(l.frames, []);
  assert.deepEqual(l.tiles ?? [], []);
});

test("saveLayout → loadLayout round-trips frames + tiles + viewport", () => {
  const repo = "/tmp/repo";
  saveLayout(repo, {
    sizes: { a: { width: 100, height: 80 } },
    positions: { a: { x: 1, y: 2 } },
    frames: [{ id: "f1", x: 0, y: 0, w: 460, h: 200, title: "F", color: "#fff", z: 3, parentFrameId: "p" }],
    tileNames: { a: "term" },
    tiles: [{ id: "a", kind: "shell", label: "shell" }],
    editorTabs: {},
    frameOf: { a: "f1" },
    viewport: { x: 5, y: 6, zoom: 1.5 },
  });
  const l = loadLayout(repo);
  assert.equal(l.frames[0]!.id, "f1");
  assert.equal(l.frames[0]!.parentFrameId, "p"); // worktree nesting persists
  assert.equal(l.tiles![0]!.kind, "shell");
  assert.deepEqual(l.frameOf, { a: "f1" });
  assert.deepEqual(l.viewport, { x: 5, y: 6, zoom: 1.5 });
});

test("migration: backfills missing frame z by index order", () => {
  const repo = "/tmp/repo2";
  store.set(LAYOUT_KEY(repo), JSON.stringify({
    frames: [{ id: "a", x: 0, y: 0, w: 1, h: 1, title: "", color: "" }, { id: "b", x: 0, y: 0, w: 1, h: 1, title: "", color: "" }],
  }));
  const l = loadLayout(repo);
  assert.equal(l.frames[0]!.z, 0);
  assert.equal(l.frames[1]!.z, 1);
});

test("migration: legacy vis/extras → TileInstance[]", () => {
  const repo = "/tmp/repo3";
  store.set(LAYOUT_KEY(repo), JSON.stringify({
    frames: [],
    vis: { tree: true, shell: true, diff: true, issues: false },
    extras: [{ id: "x", label: "claude", cmd: "claude", args: [] }],
  }));
  const l = loadLayout(repo);
  const kinds = (l.tiles ?? []).map((t) => t.kind).sort();
  // claude (from extras) + editor (tree) + shell + diff
  assert.deepEqual(kinds, ["claude", "diff", "editor", "shell"]);
  assert.ok((l.tiles ?? []).some((t) => t.id === WORKBENCH_TILE_ID));
});

test("migration: seeds frameOf from geometry when absent", () => {
  const repo = "/tmp/repo4";
  store.set(LAYOUT_KEY(repo), JSON.stringify({
    frames: [{ id: "f", x: 0, y: 0, w: 1000, h: 1000, title: "", color: "", z: 0 }],
    positions: { t: { x: 100, y: 100 } },
    sizes: { t: { width: 200, height: 200 } }, // center (200,200) ∈ frame
    tiles: [{ id: "t", kind: "shell", label: "" }],
  }));
  const l = loadLayout(repo);
  assert.equal(l.frameOf?.t, "f");
});

test("corrupt JSON → safe empty layout (no throw)", () => {
  const repo = "/tmp/repo5";
  store.set(LAYOUT_KEY(repo), "{not json");
  const l = loadLayout(repo);
  assert.deepEqual(l.frames, []);
});
