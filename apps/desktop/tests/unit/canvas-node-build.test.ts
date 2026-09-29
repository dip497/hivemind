// buildBaseNodes is the pure react-flow node-array builder for the canvas view.
// Covers: parents-before-children frame ordering, relative child positioning,
// zIndex tiers, the shell-only tile data (bodies come from the TileHost), the
// editor/diff repo gate (shared with the surface builder via effectiveRepoOf),
// and the board's boxes.
// Repo SCOPING of tile bodies moved to tile-surfaces.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaseNodes, reuseNodes, type NodeBuildCtx } from "../../src/renderer/src/canvas-node-build.ts";
import type { FrameState, TileInstance } from "../../src/renderer/src/canvas-persistence.ts";

const noop = () => {};
function ctx(over: Partial<NodeBuildCtx>): NodeBuildCtx {
  return {
    repoPath: "/base/repo",
    tiles: [], frames: [], frameOf: {}, pins: {}, sizes: {}, positions: {}, objects: [],
    frameTiles: new Map(),
    updateFrameTitle: noop, updateFrameColor: noop, deleteFrame: noop, arrangeFrame: noop,
    bringFrameToFront: noop, onAttachWorktree: noop, onCreateWorktree: noop, unbindBranch: noop,
    bindWorkspace: noop, unbindWorkspace: noop, closeTile: noop, onNodeResizeCommit: noop,
    onTogglePin: noop, onPinChange: noop,
    ...over,
  };
}
const frame = (over: Partial<FrameState>): FrameState => ({
  id: "f", x: 0, y: 0, w: 800, h: 600, title: "F", color: "#fff", z: 1, ...over,
});
const tile = (over: Partial<TileInstance>): TileInstance => ({ id: "t", kind: "shell", label: "shell", ...over });
const byId = (nodes: ReturnType<typeof buildBaseNodes>, id: string) => nodes.find((n) => n.id === id)!;

test("tile nodes carry SHELL data only — no body data (cwd/repoPath/root live on the surface)", () => {
  const nodes = buildBaseNodes(ctx({ tiles: [tile({ id: "sh" }), tile({ id: "ed", kind: "editor", label: "Editor" })] }));
  const sh = byId(nodes, "sh");
  assert.equal(sh.type, "terminal");
  const d = sh.data as Record<string, unknown>;
  assert.equal(d.tileId, "sh");
  assert.equal(typeof d.onResize, "function");
  assert.equal(typeof d.onClose, "function");
  assert.equal("cwd" in d, false, "body data must not be on the node");
  assert.equal("cmd" in d, false);
  assert.equal(d.headerPin, true, "terminals dock the pin in their own header");
  assert.equal(byId(nodes, "ed").type, "workbench", "editor kind renders as the workbench node type");
});

test("a framed tile is parented + positioned RELATIVE to its frame; where it is pinned comes from this person's pins", () => {
  const frames = [frame({ id: "wt", x: 100, y: 50 })];
  const nodes = buildBaseNodes(ctx({
    frames, tiles: [tile({ id: "sh" })],
    frameOf: { sh: "wt" }, positions: { sh: { x: 130, y: 90 } }, pins: { sh: { anchor: { sx: 1, sy: 2 }, size: { w: 300, h: 200 } } },
  }));
  const sh = byId(nodes, "sh");
  assert.equal(sh.parentId, "wt");
  assert.deepEqual(sh.position, { x: 30, y: 40 });
  assert.equal((sh.style as { zIndex: number }).zIndex, 100, "tiles sit above frames");
  const d = sh.data as Record<string, unknown>;
  assert.equal(d.pinned, true);
  assert.deepEqual(d.pinAnchor, { sx: 1, sy: 2 });
  assert.deepEqual(d.pinSize, { w: 300, h: 200 });
});

test("frames emit PARENTS before worktree CHILDREN; child position is relative + zIndex tiers hold", () => {
  const frames = [
    frame({ id: "child", x: 120, y: 140, parentFrameId: "parent", z: 5 }),
    frame({ id: "parent", x: 100, y: 100, z: 3 }),
  ];
  const nodes = buildBaseNodes(ctx({ frames }));
  const order = nodes.filter((n) => n.type === "frame").map((n) => n.id);
  assert.deepEqual(order, ["parent", "child"], "parent emitted before its child");
  const child = byId(nodes, "child");
  assert.deepEqual(child.position, { x: 20, y: 40 }, "child position relative to parent (120-100, 140-100)");
  assert.equal(child.parentId, "parent");
  // zIndex: parent ≤40, child 50–90.
  const pz = (byId(nodes, "parent").style as { zIndex: number }).zIndex;
  const cz = (child.style as { zIndex: number }).zIndex;
  assert.ok(pz <= 40 && cz >= 50 && cz < 100, `parent ${pz} < child ${cz} < 100`);
});

test("editor/diff tiles are skipped when there's no repo — but a zone repo counts", () => {
  const none = buildBaseNodes(ctx({
    repoPath: null,
    tiles: [tile({ id: "ed", kind: "editor", label: "Editor" }), tile({ id: "sh", kind: "shell" })],
  }));
  assert.equal(none.find((n) => n.id === "ed"), undefined, "editor skipped without a repo");
  assert.ok(none.find((n) => n.id === "sh"), "shell still rendered");
  const zoned = buildBaseNodes(ctx({
    repoPath: null,
    frames: [frame({ id: "ws", workspacePath: "/other/proj" })],
    tiles: [tile({ id: "ed", kind: "editor", label: "Editor" })],
    frameOf: { ed: "ws" }, positions: { ed: { x: 0, y: 0 } },
  }));
  assert.ok(zoned.find((n) => n.id === "ed"), "editor inside a workspace-zone frame renders with no global repo");
});

test("a rebuild keeps the object of every node that did not change", () => {
  const f = frame({ id: "f" });
  const c = ctx({ tiles: [tile({ id: "a" }), tile({ id: "b" })], frames: [f], frameOf: { a: "f" } });
  const first = buildBaseNodes(c);
  const prev = new Map(first.map((n) => [n.id, n]));
  const again = reuseNodes(prev, buildBaseNodes({ ...c, positions: { ...c.positions } }));
  for (const n of again) assert.equal(n, prev.get(n.id), n.id);
  const moved = reuseNodes(prev, buildBaseNodes({ ...c, sizes: { b: { width: 900, height: 700 } } }));
  assert.equal(byId(moved, "a"), prev.get("a"));
  assert.notEqual(byId(moved, "b"), prev.get("b"));
});

test("a board box is a node of its kind, drawn RELATIVE to its frame and in front of the tiles; an arrow is no node", () => {
  const nodes = buildBaseNodes(ctx({
    frames: [frame({ id: "f", x: 100, y: 50 })],
    tiles: [tile({ id: "sh" })],
    objects: [
      { id: "n1", kind: "note", frame: "f", x: 130, y: 90, w: 220, h: 180, z: 1, color: "yellow", text: "in the frame" },
      { id: "t1", kind: "text", x: 10, y: 20, w: 320, h: 64, text: "loose" },
      { id: "a1", kind: "arrow", from: { id: "n1", side: "right" }, to: { id: "sh", side: "left" }, label: "" },
    ],
  }));
  const note = byId(nodes, "n1");
  assert.equal(note.type, "note");
  assert.equal(note.parentId, "f");
  assert.deepEqual(note.position, { x: 30, y: 40 });
  const z = (id: string) => (byId(nodes, id).style as { zIndex: number }).zIndex;
  assert.ok(z("n1") > z("sh"), "a note is in front of the tiles");
  assert.equal(byId(nodes, "t1").parentId, undefined);
  assert.deepEqual(byId(nodes, "t1").position, { x: 10, y: 20 });
  assert.equal(nodes.some((n) => n.id === "a1"), false);
});
