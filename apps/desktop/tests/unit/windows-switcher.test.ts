// The Windows view's quick switcher and layouts: what it lists first for a query (needs-you, then
// the best match, then the most recent), the recent order, and which tiles a frame or a page holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTiles, rankEntries, touch, type GroupFrame } from "../../views/windows/src/switcher.ts";
import type { Attention } from "@hivemind/core/attention";

const tiles = [
  { id: "t1", title: "front end", agent: "claude", folder: "web" },
  { id: "t2", title: "safe deploy", agent: "codex", folder: "infra" },
  { id: "t3", title: "shell", folder: "web" },
  { id: "t4", title: "reviewer", agent: "claude", folder: "api" },
];
const quiet = (): Attention => "quiet";

test("with nothing typed, the tiles that need you come first, the newest of them first, then the most recently shown", () => {
  const needs = new Set(["t2", "t4"]);
  const since: Record<string, number> = { t2: 10, t4: 20 };
  const ids = rankEntries(tiles, "", (id) => (needs.has(id) ? "needs-you" : "quiet"), ["t3", "t1"], (id) => since[id] ?? 0).map((e) => e.id);
  assert.deepEqual(ids, ["t4", "t2", "t3", "t1"]);
});

test("a query finds by title, agent or folder, letters in order; one starting a word ranks above one inside a word", () => {
  assert.deepEqual(rankEntries(tiles, "fe", quiet, []).map((e) => e.id), ["t1", "t2"]);
  assert.deepEqual(rankEntries(tiles, "codex", quiet, []).map((e) => e.id), ["t2"]);
  assert.deepEqual(rankEntries(tiles, "infra", quiet, []).map((e) => e.id), ["t2"]);
  assert.deepEqual(rankEntries(tiles, "zz", quiet, []), []);
});

test("a tile that needs you stays first among the matches", () => {
  const ids = rankEntries(tiles, "e", (id) => (id === "t3" ? "needs-you" : "quiet"), []).map((e) => e.id);
  assert.equal(ids[0], "t3");
});

test("the recent order puts the one shown first and keeps the rest; the same list back when it already leads", () => {
  const r = touch(["a", "b", "c"], "c");
  assert.deepEqual(r, ["c", "a", "b"]);
  assert.equal(touch(r, "c"), r);
});

test("tiles group by their frame, or by the nearest page above their frame; outside any, a group of their own", () => {
  const frames = new Map<string, GroupFrame>([
    ["f1", { id: "f1", title: "Repo", page: true }],
    ["f2", { id: "f2", title: "Worktree", parentId: "f1" }],
    ["f3", { id: "f3", title: "Notes" }],
  ]);
  const ts = [{ id: "a", frameId: "f2" }, { id: "b", frameId: "f1" }, { id: "c", frameId: "f3" }, { id: "d", frameId: null }];
  assert.deepEqual(groupTiles(ts, frames, "frame").map((g) => [g.key, g.tiles]), [["frame:f2", ["a"]], ["frame:f1", ["b"]], ["frame:f3", ["c"]], ["frame:", ["d"]]]);
  assert.deepEqual(groupTiles(ts, frames, "page").map((g) => [g.key, g.label, g.tiles]), [["page:f1", "Repo", ["a", "b"]], ["page:", "Top level", ["c", "d"]]]);
});
