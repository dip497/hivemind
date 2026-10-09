// The core layout blob through loadLayout/saveLayout (pure module functions, no
// React), with no bridge: localStorage is where it lives, and a tiny in-memory
// shim stands in for it. Moving it into main's store is
// workspace-store-client.test.ts.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Shim window.localStorage BEFORE importing the module (load/save read window
// at call time).
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { loadLayout, saveLayout } = await import("../../src/renderer/src/canvas-persistence.ts");

beforeEach(() => store.clear());

const SNAP = {
  frames: [{ id: "f1", x: 0, y: 0, w: 460, h: 200, title: "F", color: "#fff", z: 3, parentFrameId: "p" }],
  tileNames: { a: "term" },
  tiles: [{ id: "a", kind: "shell" as const, label: "shell" }, { id: "p1", kind: "planReview" as const, label: "Plan" }],
  editorTabs: {},
  frameOf: { a: "f1" },
};

test("no repo → empty layout, and nothing is saved", () => {
  saveLayout(null, SNAP);
  assert.equal(store.size, 0);
  const l = loadLayout(null);
  assert.deepEqual(l.frames, []);
  assert.deepEqual(l.tiles ?? [], []);
});

test("saveLayout → loadLayout round-trips the core (frames + tiles + membership), never a plan review", () => {
  const repo = "/tmp/repo";
  saveLayout(repo, SNAP);
  const l = loadLayout(repo);
  assert.equal(l.frames[0]!.id, "f1");
  assert.equal(l.frames[0]!.parentFrameId, "p"); // worktree nesting persists
  assert.deepEqual(l.tiles!.map((t) => t.id), ["a"]); // a plan review is tied to a live hook: never saved
  assert.deepEqual(l.frameOf, { a: "f1" });
  assert.deepEqual(l.tileNames, { a: "term" });
});

test("corrupt JSON → safe empty layout (no throw)", () => {
  const repo = "/tmp/repo5";
  saveLayout(repo, SNAP);
  assert.equal(store.size, 1);
  for (const key of store.keys()) store.set(key, "{not json");
  const l = loadLayout(repo);
  assert.deepEqual(l.frames, []);
});

test("a frame stored with no place (opened without a window) is placed as the window reads it: nested in its parent's free slot, or right of the others", () => {
  const repo = "/tmp/repo-unplaced";
  const own = { id: "own", x: 100, y: 100, w: 2000, h: 1200, title: "api", color: "#123", z: 2, workspacePath: "/work/api" };
  saveLayout(repo, { ...SNAP, frames: [own], frameOf: {} });
  for (const [key, value] of store) {
    const blob = JSON.parse(value) as { frames: unknown[] };
    blob.frames.push({ id: "wt", title: "fix-1", branch: "fix-1", worktreePath: "/work/api-worktrees/fix-1", parentFrameId: "own" }, { id: "top", title: "docs", workspacePath: "/work/docs" });
    store.set(key, JSON.stringify(blob));
  }
  const [, wt, top] = loadLayout(repo).frames;
  assert.ok(wt!.x > own.x && wt!.y > own.y && wt!.x + wt!.w <= own.x + own.w, "inside its parent");
  assert.ok(top!.x >= own.x + own.w, "right of the others");
  for (const f of [wt!, top!]) {
    assert.ok([f.x, f.y, f.w, f.h, f.z].every(Number.isFinite), `${f.id} has a place, a size and a depth`);
    assert.equal(typeof f.color, "string");
    assert.ok(f.z > own.z);
  }
  assert.deepEqual(loadLayout(repo).frames[0], own, "a placed frame is kept as it was");
});
