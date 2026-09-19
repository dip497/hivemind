// buildTileSurfaces is the pure, view-independent description of every tile
// body. These cover the "effective repo" invariant that used to live in
// canvas-node-build's mkTile: worktree / workspace zone cwd·repoPath·root
// scoping (incl. the cross-repo-leak guard), the repo gate, and the fact that a
// surface is keyed by tile id and carries the same shape whatever view shows it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTileSurfaces, createTileSurfaceBuilder, effectiveRepoOf, type TileSurfaceCtx } from "../../src/renderer/src/workspace/tile-surfaces.ts";
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

test("cache preserves untouched bodies when renaming, editing tabs, navigating, pinning or adding tiles", () => {
  const build = createTileSurfaceBuilder();
  const base = ctx({ tiles: [tile({ id: "a" }), tile({ id: "b", kind: "editor" }), tile({ id: "c", kind: "browser" })] });
  const first = build(base);
  const renamed = build({ ...base, tileNames: { a: "New name" } });
  assert.notEqual(renamed[0], first[0]);
  assert.equal(renamed[1], first[1]);
  assert.equal(renamed[2], first[2]);
  const tabs = build({ ...base, editorTabs: { b: ["file.ts"] } });
  assert.notEqual(tabs[1], first[1]);
  assert.equal(tabs[2], first[2]);
  const navigated = build({ ...base, browserOpenReqs: { c: { url: "https://example.com", seq: 1 } } });
  assert.notEqual(navigated[2], first[2]);
  const pin = build({ ...base, pinnedIds: new Set(["a"]) });
  const added = build({ ...base, pinnedIds: new Set(["a"]), tiles: [...base.tiles, tile({ id: "d" })] });
  for (let i = 0; i < 3; i++) assert.equal(added[i], pin[i]);
});

test("frame geometry preserves bodies; workspace binding and root changes invalidate scope", () => {
  const build = createTileSurfaceBuilder();
  const owner = frame({ workspacePath: "/other", workspaceRoot: "/other/.hivemind" });
  const base = ctx({ tiles: [tile({ id: "a" }), tile({ id: "b", kind: "issues" }), tile({ id: "loose" })], frames: [owner], frameOf: { a: "f", b: "f" } });
  const first = build(base);
  const moved = build({ ...base, frames: [{ ...owner, x: 200, title: "Moved" }] });
  first.forEach((surface, i) => assert.equal(moved[i], surface));
  const rebound = build({ ...base, frames: [{ ...owner, workspacePath: "ssh://host/other", workspaceRoot: null }] });
  assert.equal(data(rebound, "a").cwd, "ssh://host/other");
  assert.equal(data(rebound, "b").root, null);
  assert.notEqual(rebound[0], first[0]);
  assert.equal(rebound[2], first[2]);
  const worktree = build({ ...base, frames: [{ ...owner, worktreePath: "/wt" }] });
  assert.equal(data(worktree, "a").cwd, "/wt");
  assert.equal(data(worktree, "b").root, base.root);
});

test("cache invalidates callbacks and tile content instead of retaining stale closures", () => {
  const build = createTileSurfaceBuilder();
  const calls: string[] = [];
  const base = ctx({ tiles: [tile({ id: "a" })], closeTile: (id) => calls.push(`old:${id}`) });
  const first = build(base);
  const changed = build({ ...base, closeTile: (id) => calls.push(`new:${id}`) });
  assert.notEqual(changed[0], first[0]);
  changed[0].data.onClose?.();
  assert.deepEqual(calls, ["new:a"]);
  const updated = build({ ...base, tiles: [{ ...base.tiles[0], cmd: "custom", args: ["--test"] }] });
  assert.equal(data(updated, "a").cmd, "custom");
  assert.deepEqual(data(updated, "a").args, ["--test"]);
});

test("cache prunes closed IDs, isolates workspaces, and rechecks repo gates", () => {
  const build = createTileSurfaceBuilder();
  const base = ctx({ tiles: [tile({ id: "a" })] });
  const first = build(base);
  assert.equal(build(base)[0], first[0]);
  assert.notEqual(createTileSurfaceBuilder()(base)[0], first[0]);
  build({ ...base, tiles: [] });
  assert.notEqual(build(base)[0], first[0]);
  const editor = ctx({ repoPath: null, tiles: [tile({ kind: "editor" })] });
  assert.deepEqual(build(editor), []);
  assert.equal(build({ ...editor, repoPath: "/available" }).length, 1);
  assert.deepEqual(build(editor), []);
});

test("global repo/cwd/root changes invalidate only scope-dependent bodies", () => {
  const build = createTileSurfaceBuilder();
  const base = ctx({ tiles: [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" }), tile({ id: "b", kind: "browser", label: "Browser" })] });
  const first = build(base);
  const moved = build({ ...base, repoPath: "/elsewhere", root: "/elsewhere/.hivemind", cwd: "/elsewhere" });
  assert.notEqual(moved[0], first[0]); // terminal cwd follows the workspace cwd
  assert.equal(data(moved, "iss").root, "/elsewhere/.hivemind");
  assert.notEqual(moved[1], first[1]); // issues root follows the workspace root
  // Conservative by contract: globals key EVERY tile, so a repo switch also
  // rebuilds repo-agnostic bodies (correct, just not minimal).
  assert.notEqual(moved[2], first[2]);
});

test("browser membership invalidates even when the frame record is missing", () => {
  const build = createTileSurfaceBuilder();
  const base = ctx({ tiles: [tile({ kind: "browser" })], frameOf: { t: "missing-a" } });
  const first = build(base);
  const next = build({ ...base, frameOf: { t: "missing-b" } });
  assert.notEqual(next[0], first[0]);
  assert.equal(data(next, "t").frameId, "missing-b");
});

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
