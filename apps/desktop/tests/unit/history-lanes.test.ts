/**
 * The commit graph's lanes (code/history-lanes.ts): a straight history is one lane; a branch that
 * merges back takes a lane of its own and comes into the merge's; a second page goes on from the
 * first's lanes, so nothing already drawn moves, and a lane freed at the right narrows the graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { laneRows } from "../../src/renderer/src/code/history-lanes";

const c = (oid: string, ...parents: string[]) => ({ oid, parents });

test("a straight history is one lane, each node going down to its parent", () => {
  const { rows, state } = laneRows([c("c", "b"), c("b", "a"), c("a")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows[1], { lane: 0, up: [{ from: 0, to: 0 }], down: [{ from: 0, to: 0 }], width: 1 });
  // The root has nowhere to go down to, and leaves no lane open.
  assert.deepEqual(rows[2]!.down, []);
  assert.deepEqual(state, []);
});

test("a merge sends its second parent down a lane of its own, which comes back into the fork point's", () => {
  //  m─┐   merge of f into main
  //  │ f   the feature's commit
  //  b │   main's commit
  //  a─┘   where they forked
  const { rows } = laneRows([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  assert.deepEqual(rows[0]!.down, [{ from: 0, to: 0 }, { from: 0, to: 1 }]);
  // Both lanes expect `a`: the feature's comes into main's at the fork.
  assert.deepEqual(rows[3]!.up, [{ from: 0, to: 0 }, { from: 1, to: 0 }]);
  assert.deepEqual(rows.map((r) => r.width), [2, 2, 2, 2]);
});

test("a second page goes on from the first's lanes: the same rows as one page, and a freed lane at the right goes", () => {
  const all = [c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a", "z"), c("z")];
  const whole = laneRows(all).rows;
  const first = laneRows(all.slice(0, 2));
  const second = laneRows(all.slice(2), first.state);
  assert.deepEqual([...first.rows, ...second.rows], whole);
  assert.deepEqual(whole[4]!.width, 1, "past the fork the graph is one lane wide again");
});
