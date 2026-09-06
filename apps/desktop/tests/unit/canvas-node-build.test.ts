// buildBaseNodes is the pure react-flow node-array builder for the canvas view.
// Covers: parents-before-children frame ordering, relative child positioning,
// zIndex tiers, the shell-only tile data (bodies come from the TileHost), and
// the editor/diff repo gate (shared with the surface builder via effectiveRepoOf).
// Repo SCOPING of tile bodies moved to tile-surfaces.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaseNodes, type NodeBuildCtx } from "../../src/renderer/src/canvas-node-build.ts";
import type { FrameState, TileInstance } from "../../src/renderer/src/canvas-persistence.ts";

const noop = () => {};
function ctx(over: Partial<NodeBuildCtx>): NodeBuildCtx {
  return {
    repoPath: "/base/repo",
    tiles: [], frames: [], frameOf: {}, pinnedIds: new Set(), sizes: {}, positions: {},
    frameTiles: new Map(), framesChipNames: {},
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

test("a framed tile is parented + positioned RELATIVE to its frame; pinned state flows from pinnedIds", () => {
  const frames = [frame({ id: "wt", x: 100, y: 50 })];
  const nodes = buildBaseNodes(ctx({
    frames, tiles: [tile({ id: "sh", pinned: true, pinAnchor: { sx: 1, sy: 2 } })],
    frameOf: { sh: "wt" }, positions: { sh: { x: 130, y: 90 } }, pinnedIds: new Set(["sh"]),
  }));
  const sh = byId(nodes, "sh");
  assert.equal(sh.parentId, "wt");
  assert.deepEqual(sh.position, { x: 30, y: 40 });
  assert.equal((sh.style as { zIndex: number }).zIndex, 100, "tiles sit above frames");
  const d = sh.data as Record<string, unknown>;
  assert.equal(d.pinned, true);
  assert.deepEqual(d.pinAnchor, { sx: 1, sy: 2 });
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
