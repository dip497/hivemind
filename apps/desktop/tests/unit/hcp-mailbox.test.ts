/**
 * Turn-aware delivery (hcp/mailbox.ts).
 *
 * The bug: agent-to-agent messages are delivered by TYPING into the target's TUI.
 * Sent while that agent is mid-turn, the text lands in its composer unsubmitted —
 * never read — and whoever waits on the answer (a supervised worker blocked on an
 * approval) hangs until timeout. These tests pin the hold-until-prompt contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mailbox } from "../../src/main/hcp/mailbox.js";

const PID = "hm:tile-claude-1";

/** Collect what actually reaches the pty. */
function harness(live = true) {
  const writes: string[] = [];
  const mb = new Mailbox((_id, data) => {
    if (!live) return false;
    writes.push(data);
    return true;
  }, 1);
  return { mb, writes };
}

/** The mailbox defers its writes on timers; let them run. */
const settle = () => new Promise((r) => setTimeout(r, 400));

test("idle tile: delivered immediately, text then Enter as separate writes", async () => {
  const { mb, writes } = harness();
  assert.equal(mb.deliver(PID, "hello"), true);
  await settle();
  assert.deepEqual(writes, ["hello", "\r"], "a bundled newline is dropped by claude's TUI");
});

test("BUSY tile: held, NOT typed into the composer — the actual bug", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  assert.equal(mb.deliver(PID, "[hive] APPROVAL — …"), true, "accepted for delivery");
  await settle();
  assert.deepEqual(writes, [], "nothing typed while mid-turn");
  assert.equal(mb.pending(PID), 1);

  mb.setIdle(PID); // turn ends → back at the prompt
  await settle();
  assert.deepEqual(writes, ["[hive] APPROVAL — …", "\r"], "delivered once it can be read");
  assert.equal(mb.pending(PID), 0);
});

test("one message per idle window — delivering starts the next turn", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  mb.deliver(PID, "first");
  mb.deliver(PID, "second");
  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, ["first", "\r"], "only the first — the agent is now busy with it");
  assert.equal(mb.pending(PID), 1);

  mb.setBusy(PID); // that message started a turn
  mb.setIdle(PID); // …which ended
  await settle();
  assert.deepEqual(writes, ["first", "\r", "second", "\r"]);
});

test("a tile we never heard a turn from (codex/opencode — no hooks) delivers immediately", async () => {
  const { mb, writes } = harness();
  mb.deliver("hm:tile-codex-9", "report");
  await settle();
  assert.deepEqual(writes, ["report", "\r"], "unknown ⇒ idle: no regression for hookless agents");
});

test("dead tile while idle reports failure (so agent.send can raise TILE_NOT_FOUND)", () => {
  const { mb } = harness(false);
  assert.equal(mb.deliver(PID, "x"), false);
});

test("queue is bounded — a parent that never returns can't grow an unbounded backlog", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  for (let i = 0; i < 40; i++) mb.deliver(PID, `msg${i}`);
  assert.equal(mb.pending(PID), 32, "capped");

  mb.setIdle(PID);
  await settle();
  // The OLDEST were dropped, so the first survivor is msg8 — the newest reports
  // are the ones that still matter.
  assert.equal(writes[0], "msg8");
});

test("forget() drops queue + busy so a recycled pty id starts clean", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  mb.deliver(PID, "stale");
  mb.forget(PID);
  assert.equal(mb.pending(PID), 0);

  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, [], "the dead tile's backlog is never replayed into its successor");
});
