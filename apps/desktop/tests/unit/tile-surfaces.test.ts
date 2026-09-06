// buildTileSurfaces is the pure, view-independent description of every tile
// body. These cover the "effective repo" invariant that used to live in
// canvas-node-build's mkTile: worktree / workspace zone cwd·repoPath·root
// scoping (incl. the cross-repo-leak guard), the repo gate, and the fact that a
// surface is keyed by tile id and carries the same shape whatever view shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTileSurfaces, effectiveRepoOf, type TileSurfaceCtx } from "../../src/renderer/src/workspace/tile-surfaces.ts";
import type { FrameState, TileInstance } from "../../src/renderer/src/canvas-persistence.ts";

const noop = () => {};
function ctx(over: Partial<TileSurfaceCtx>): TileSurfaceCtx {
  return {
    repoPath: "/base/repo", root: "/base/repo/.hivemind", cwd: "/base/repo",
    tiles: [], frames: [], frameOf: {}, pinnedIds: new Set(), editorTabs: {}, browserOpenReqs: {}, tileNames: {},
    openFileInTile: noop, openUrlInBrowser: noop, openFileFromTerminal: noop, closeTabInTile: noop,
    closeTile: noop, renameTile: noop, setAgentTitle: noop, onTogglePin: noop,
    ...over,
  };
}
const frame = (over: Partial<FrameState>): FrameState => ({
  id: "f", x: 0, y: 0, w: 800, h: 600, title: "F", color: "#fff", z: 1, ...over,
});
const tile = (over: Partial<TileInstance>): TileInstance => ({ id: "t", kind: "shell", label: "shell", ...over });
const byId = (s: ReturnType<typeof buildTileSurfaces>, id: string) => s.find((x) => x.id === id)!;
const data = (s: ReturnType<typeof buildTileSurfaces>, id: string) => byId(s, id).data as Record<string, unknown>;

test("tile in a WORKTREE zone scopes cwd + repoPath to the worktree path; issues root stays base", () => {
  const frames = [frame({ id: "wt", worktreePath: "/wt/feature", branch: "feature", parentFrameId: "repo" }), frame({ id: "repo" })];
  const tiles = [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" }), tile({ id: "df", kind: "diff", label: "Diff" })];
  const s = buildTileSurfaces(ctx({ frames, tiles, frameOf: { sh: "wt", iss: "wt", df: "wt" } }));
  assert.equal(data(s, "sh").cwd, "/wt/feature"); // terminal runs in the worktree
  assert.equal(data(s, "df").repoPath, "/wt/feature");
  // A worktree shares the repo's .hivemind — issues stay the BASE root, NOT the worktree.
  assert.equal(data(s, "iss").root, "/base/repo/.hivemind");
});

test("tile in a WORKSPACE zone scopes cwd/repoPath/root to the bound repo", () => {
  const frames = [frame({ id: "ws", workspacePath: "/other/proj", workspaceRoot: "/other/proj/.hivemind" })];
  const s = buildTileSurfaces(ctx({
    frames,
    tiles: [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" }), tile({ id: "ed", kind: "editor", label: "Editor" })],
    frameOf: { sh: "ws", iss: "ws", ed: "ws" },
  }));
  assert.equal(data(s, "sh").cwd, "/other/proj");
  assert.equal(data(s, "iss").root, "/other/proj/.hivemind");
  assert.equal(data(s, "ed").repoPath, "/other/proj");
});

test("cross-repo-leak guard: a workspace zone with NO .hivemind nulls root (never leaks base)", () => {
  const frames = [frame({ id: "ws", workspacePath: "/other/proj", workspaceRoot: null })];
  const s = buildTileSurfaces(ctx({ frames, tiles: [tile({ id: "iss", kind: "issues", label: "Issues" })], frameOf: { iss: "ws" } }));
  assert.equal(data(s, "iss").root, null);
});

test("a base-frame (no zone) tile keeps the workspace base cwd/repoPath/root", () => {
  const frames = [frame({ id: "base", workspacePath: undefined })];
  const s = buildTileSurfaces(ctx({
    frames, tiles: [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" })], frameOf: { sh: "base", iss: "base" },
  }));
  assert.equal(data(s, "sh").cwd, "/base/repo");
  assert.equal(data(s, "iss").root, "/base/repo/.hivemind");
});

test("editor/diff surfaces are skipped when there's no repo anywhere", () => {
  const s = buildTileSurfaces(ctx({
    repoPath: null, root: null,
    tiles: [tile({ id: "ed", kind: "editor", label: "Editor" }), tile({ id: "sh", kind: "shell" })],
  }));
  assert.equal(s.find((x) => x.id === "ed"), undefined);
  assert.ok(s.find((x) => x.id === "sh"));
  assert.equal(effectiveRepoOf("ed", {}, [], null), null);
});

test("surface type follows the tile kind; terminal name resolves rename ?? auto name from cmd", () => {
  const s = buildTileSurfaces(ctx({
    tiles: [
      tile({ id: "c", kind: "claude", cmd: "claude", args: [] }),
      tile({ id: "sh", kind: "shell", cmd: "/bin/bash", args: ["-il"] }),
      tile({ id: "b", kind: "browser", label: "Browser", url: "https://example.com" }),
      tile({ id: "ed", kind: "editor", label: "Editor" }),
      tile({ id: "pr", kind: "planReview", label: "Plan", review: { plan: "p", cwd: "/x" } }),
    ],
    tileNames: { sh: "build box" },
    editorTabs: { ed: ["src/a.ts"] },
    browserOpenReqs: { b: { url: "https://x", seq: 3 } },
  }));
  assert.deepEqual(s.map((x) => [x.id, x.type]), [["c", "terminal"], ["sh", "terminal"], ["b", "browser"], ["ed", "workbench"], ["pr", "planReview"]]);
  assert.equal(data(s, "c").name, "claude");
  assert.equal(data(s, "sh").name, "build box");
  assert.deepEqual(data(s, "ed").tabs, ["src/a.ts"]);
  assert.deepEqual(data(s, "b").openReq, { url: "https://x", seq: 3 });
  assert.equal(data(s, "pr").cwd, "/x");
});
