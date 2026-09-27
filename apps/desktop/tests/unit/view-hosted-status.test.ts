// Views' turn and subagent events come from the host's session statuses: a turn its hooks ended
// counts once, a screen-read idle is not a hook turn, and every change in subagents is passed on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feedHostedStatus } from "../../src/renderer/src/workspace/view-services.ts";

const status = (state: string, source: "hooks" | "screen" | null, subagents: string[] = []) =>
  ({ state, source, subagents, background: 0, compacting: false, since: 0 }) as never;

test("hook turn ends and subagent counts", () => {
  const got: string[] = [];
  const hub = { onHookTurn: (id: string) => got.push(`turn ${id}`), onSubagents: (id: string, n: number) => got.push(`subagents ${id} ${n}`) };
  const last = new Map();
  const feed = (tileId: string, s: unknown) => feedHostedStatus(hub as never, last, { seq: 0, tileId, status: s as never });
  feed("a", status("working", "hooks"));
  feed("a", status("working", "hooks", ["s1", "s2"]));
  feed("a", status("done", "hooks", ["s1"]));
  feed("a", status("done", "hooks", ["s1"])); // the same end, told again
  feed("a", status("working", "hooks"));
  feed("a", status("interrupted", "hooks"));
  feed("b", status("working", "screen"));
  feed("b", status("done", "screen"));
  assert.deepEqual(got, ["subagents a 2", "turn a", "subagents a 1", "subagents a 0", "turn a"]);
});
