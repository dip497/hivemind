// Unit test for the per-tile subagent tracker. Run: pnpm test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { SubagentTracker } from "../../src/main/hcp/subagent-tracker.ts";

test("idle → busy edge reported once; second start is not a new edge", () => {
  const t = new SubagentTracker();
  assert.equal(t.start("tile-a", "ag1"), true); // first subagent → transitioned
  assert.equal(t.busy("tile-a"), true);
  assert.equal(t.start("tile-a", "ag2"), false); // already busy → no edge
  assert.equal(t.busy("tile-a"), true);
});

test("busy → idle edge only on the LAST stop", () => {
  const t = new SubagentTracker();
  t.start("tile-a", "ag1");
  t.start("tile-a", "ag2");
  assert.equal(t.stop("tile-a", "ag1"), false); // one still running
  assert.equal(t.busy("tile-a"), true);
  assert.equal(t.stop("tile-a", "ag2"), true); // last one → idle edge
  assert.equal(t.busy("tile-a"), false);
});

test("duplicate start (same id) is idempotent — set-based, can't drift", () => {
  const t = new SubagentTracker();
  t.start("tile-a", "ag1");
  t.start("tile-a", "ag1"); // same id again (e.g. re-fired hook)
  assert.equal(t.stop("tile-a", "ag1"), true); // single stop clears it
  assert.equal(t.busy("tile-a"), false);
});

test("stop for unknown tile / id is a harmless no-op", () => {
  const t = new SubagentTracker();
  assert.equal(t.stop("ghost", "x"), false);
  t.start("tile-a", "ag1");
  assert.equal(t.stop("tile-a", "other"), false); // unknown id, still busy
  assert.equal(t.busy("tile-a"), true);
});

test("empty agentId still toggles busy via sentinel", () => {
  const t = new SubagentTracker();
  assert.equal(t.start("tile-a", ""), true);
  assert.equal(t.busy("tile-a"), true);
  assert.equal(t.stop("tile-a", ""), true);
  assert.equal(t.busy("tile-a"), false);
});

test("forget reports prior busy and clears", () => {
  const t = new SubagentTracker();
  t.start("tile-a", "ag1");
  assert.equal(t.forget("tile-a"), true);
  assert.equal(t.busy("tile-a"), false);
  assert.equal(t.forget("tile-a"), false); // already gone
});

test("tiles are independent", () => {
  const t = new SubagentTracker();
  t.start("tile-a", "ag1");
  assert.equal(t.busy("tile-a"), true);
  assert.equal(t.busy("tile-b"), false);
});
