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

test("saveLayout → loadLayout round-trips the core (frames + tiles + membership)", () => {
  const repo = "/tmp/repo";
  saveLayout(repo, {
    frames: [{ id: "f1", x: 0, y: 0, w: 460, h: 200, title: "F", color: "#fff", z: 3, parentFrameId: "p" }],
    tileNames: { a: "term" },
    tiles: [{ id: "a", kind: "shell", label: "shell" }],
    editorTabs: {},
    frameOf: { a: "f1" },
  });
  const l = loadLayout(repo);
  assert.equal(l.frames[0]!.id, "f1");
  assert.equal(l.frames[0]!.parentFrameId, "p"); // worktree nesting persists
  assert.equal(l.tiles![0]!.kind, "shell");
  assert.deepEqual(l.frameOf, { a: "f1" });
  assert.deepEqual(l.tileNames, { a: "term" });
});

test("corrupt JSON → safe empty layout (no throw)", () => {
  const repo = "/tmp/repo5";
  store.set(LAYOUT_KEY(repo), "{not json");
  const l = loadLayout(repo);
  assert.deepEqual(l.frames, []);
});
