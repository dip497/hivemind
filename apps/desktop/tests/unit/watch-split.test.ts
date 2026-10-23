// A window's watch or read of tiles of several workspaces (watch-split.ts): each tile goes to the
// host of the workspace it is of, by its bare id, and the lines each host answers are put together;
// a host that refuses (one older than Workspace API 0.34) takes no line from the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLines, splitTiles } from "../../src/main/watch-split";

test("a window's tiles are split by the workspace shared from elsewhere each is of, a session's id read as its tile; the rest stay this host's", () => {
  const of: Record<string, string> = { g1: "ws-guest", g2: "ws-guest", o1: "ws-other" };
  const { here, there } = splitTiles(["t1", "hm:g1", "g2", "o1", 7], (bare) => of[bare] ?? null);
  assert.deepEqual(here, ["t1", 7]);
  assert.deepEqual(Object.fromEntries(there), { "ws-guest": ["hm:g1", "g2"], "ws-other": ["o1"] });
});

test("the lines each host answers are put together; a host that refused gives none and takes none from the others; all refusing, the first refusal is the answer", () => {
  const refused = { error: { code: "UNKNOWN_METHOD" as const, message: "unknown method: tile.watchLines" } };
  assert.deepEqual(joinLines([{ result: { lines: { t1: "npm test" } } }, refused, { result: { lines: { g1: "214 tests passed" } } }]),
    { result: { lines: { t1: "npm test", g1: "214 tests passed" } } });
  assert.deepEqual(joinLines([refused, { error: { code: "FAILED", message: "not connected" } }]), refused);
});
