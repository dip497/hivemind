// The control plane's reading of a workspace (src/tile-list.ts): which frame a name means, and the
// tiles and frames as `hive ctl list` and `hive ctl frames` print them. What a tile is called is
// owned by the desktop's tile-surfaces test; here it is only carried into the list.
import { expect, test } from "bun:test";
import { frameFor, listFrames, listTiles, type FrameListing, type TileListing } from "../src/tile-list.ts";

const frame = (id: string, title: string, over: Partial<FrameListing> = {}): FrameListing => ({ id, title, ...over });
const tile = (id: string, over: Partial<TileListing> = {}): TileListing => ({ id, kind: "shell", label: id, ...over });

test("a frame is found by its id, then its title in any case, then the folder it runs in, then a title containing the name", () => {
  const frames = [
    frame("f1", "API", { workspacePath: "/src/web" }),
    frame("f2", "Web", { worktreePath: "/src/wt/fix-login/", branch: "fix-login" }),
    frame("f3", "Fix-login notes"),
    frame("web", "Docs"),
  ];
  expect(frameFor(frames, "web")?.id).toBe("web");
  expect(frameFor(frames, "WEB")?.id).toBe("f2");
  expect(frameFor(frames, "fix-login")?.id).toBe("f2");
  expect(frameFor(frames, "doc")?.id).toBe("web");
  expect(frameFor(frames, "nothing")).toBeUndefined();
});

const ws = {
  frames: [
    frame("f1", "API", { workspacePath: "/src/api" }),
    frame("f2", "Empty"),
    // A worktree of the repository: its tiles run in the worktree.
    frame("f3", "Fix", { workspacePath: "/src/api", worktreePath: "/src/wt/fix", branch: "fix" }),
  ],
  tiles: [
    tile("t1", { kind: "claude", label: "claude #1" }),
    tile("t2"),
    tile("t3", { kind: "claude", label: "claude #2" }),
    tile("t4"),
    tile("t5"),
  ],
  frameOf: { t1: "f1", t2: "f1", t3: "f3", t4: "gone" },
  names: { t2: "server" },
};
const facts = {
  status: (id: string) => (id === "t1" ? "working" : "idle"),
  titles: { t1: "reviewing the API" },
  agent: (t: TileListing) => (t.kind === "claude" ? "claude" : undefined),
};

test("tiles are listed by the frame they are in, a frame with none left out; one in no frame, or in a frame that is gone, is loose", () => {
  expect(listTiles(ws, facts)).toEqual({
    frames: [
      { frameId: "f1", title: "API", repo: "/src/api", branch: null, tiles: [
        { tileId: "t1", kind: "claude", label: "claude #1", status: "working", name: "reviewing the API", agent: "claude" },
        { tileId: "t2", kind: "shell", label: "t2", status: "idle", name: "server" },
      ] },
      { frameId: "f3", title: "Fix", repo: "/src/wt/fix", branch: "fix", tiles: [
        { tileId: "t3", kind: "claude", label: "claude #2", status: "idle", name: "claude #2", agent: "claude" },
      ] },
    ],
    loose: [
      { tileId: "t4", kind: "shell", label: "t4", status: "idle", name: "t4" },
      { tileId: "t5", kind: "shell", label: "t5", status: "idle", name: "t5" },
    ],
  });
});

test("listed for one frame, that frame alone, even with no tiles", () => {
  expect(listTiles(ws, facts, ws.frames[1])).toEqual({ frames: [{ frameId: "f2", title: "Empty", repo: null, branch: null, tiles: [] }], loose: [] });
  expect(listTiles(ws, facts, ws.frames[2]).frames.map((f) => f.tiles.map((t) => t.tileId))).toEqual([["t3"]]);
});

test("every frame is summarised with where its tiles run and how many it holds", () => {
  expect(listFrames(ws)).toEqual([
    { id: "f1", title: "API", repo: "/src/api", branch: null, tiles: 2 },
    { id: "f2", title: "Empty", repo: null, branch: null, tiles: 0 },
    { id: "f3", title: "Fix", repo: "/src/wt/fix", branch: "fix", tiles: 1 },
  ]);
});
