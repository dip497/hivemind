/**
 * Shoal's sharks echo the agents' status (shoal/roster): a shark comes up only for an agent that
 * waits on a person, and when the water is full the agents that need you keep their sharks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SHARKS, roster, turnEnded, type ShoalAgent } from "../../src/renderer/src/shoal/roster";
import type { TileStatusKind } from "../../src/renderer/src/agent-status-bus";

const agent = (tileId: string, sleeping = false): ShoalAgent => ({ tileId, agent: "a", sleeping });

test("each status gives its shark a mood, and only a wait on a person brings it up", () => {
  const rows: [TileStatusKind | null, boolean, string][] = [
    ["working", false, "hunt"],
    ["idle", false, "cruise"],
    [null, false, "cruise"],
    ["permission", false, "surface"],
    ["question", false, "surface"],
    ["blocked", false, "surface"],
    ["plan_review", false, "surface"],
    // A supervised worker waits on its supervisor, not on you.
    ["awaiting_approval", false, "cruise"],
    ["exited", false, "rest"],
    // Asleep outranks whatever its last status was.
    ["working", true, "rest"],
  ];
  for (const [status, sleeping, mood] of rows) {
    const [shark] = roster([agent("t", sleeping)], () => status);
    assert.equal(shark?.mood, mood, `${status}${sleeping ? " asleep" : ""}`);
  }
});

test("a full shoal keeps the agents that need you, then those at work, in the agents' order", () => {
  const ids = Array.from({ length: MAX_SHARKS + 3 }, (_, i) => `t${i}`);
  const status: Record<string, TileStatusKind> = { t0: "idle", t1: "idle", t2: "idle", t9: "question", t10: "working" };
  const sharks = roster(ids.map((id) => agent(id)), (id) => status[id] ?? "exited");
  assert.equal(sharks.length, MAX_SHARKS);
  const keys = sharks.map((s) => s.key);
  assert.ok(keys.includes("t9") && keys.includes("t10"), keys.join(","));
  assert.deepEqual(keys, [...keys].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  // The same agent is the same shark every time.
  assert.deepEqual(roster([agent("t3")], () => "idle"), roster([agent("t3")], () => "idle"));
});

test("only a turn that ends well is a bite: not one interrupted, failed or cut short by a limit", () => {
  assert.equal(turnEnded("working", { status: "idle" }), true);
  assert.equal(turnEnded("working", { status: "idle", synthetic: true, detail: "interrupted" }), false);
  // A tile's own idle that is not a finish says so without a reason.
  assert.equal(turnEnded("working", { status: "idle", synthetic: true }), false);
  assert.equal(turnEnded("working", { status: "idle", detail: "turn failed" }), false);
  assert.equal(turnEnded("working", { status: "idle", detail: "usage limit reached" }), false);
  assert.equal(turnEnded("working", { status: "permission" }), false);
  assert.equal(turnEnded("idle", { status: "idle" }), false);
  assert.equal(turnEnded("question", { status: "idle" }), false);
});
