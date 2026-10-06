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
import { Mailbox } from "@hivemind/host/control/mailbox";

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

test("duplicate idle signals release exactly ONE message — pi posts turn AND status:idle", async () => {
  // pi's agent_end fires BOTH a `turn` and a `status:idle` event, so setIdle is called
  // twice per turn. A pop-per-setIdle mailbox drained two messages at once and typed the
  // second into the now-busy TUI, where it was lost — the very bug the mailbox exists to
  // stop, reborn for pi parents.
  const { mb, writes } = harness();
  mb.setBusy(PID);
  mb.deliver(PID, "A");
  mb.deliver(PID, "B");
  mb.deliver(PID, "C");
  mb.setIdle(PID); // from the `turn` event
  mb.setIdle(PID); // from the `status:idle` event — same turn
  await settle();
  assert.deepEqual(writes, ["A", "\r"], "one message, not two");
  assert.equal(mb.pending(PID), 2);
});

test("a message arriving in the post-turn settle window is queued, not raced ahead", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  mb.deliver(PID, "A");
  mb.setIdle(PID); // schedules A's release ~250ms out
  mb.deliver(PID, "B"); // arrives DURING the settle window
  await settle();
  assert.deepEqual(writes, ["A", "\r"], "B did not jump the queue and collide with A");
  assert.equal(mb.pending(PID), 1);
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

test("the person's draft: a message is held, not merged into what they are typing", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID); mb.setIdle(PID); // a hooked agent, at its prompt
  mb.typed(PID, "fix the");
  mb.deliver(PID, "report from B");
  await settle();
  assert.deepEqual(writes, [], "nothing typed into the person's draft");
  assert.equal(mb.pending(PID), 1);

  mb.typed(PID, "\r"); // they send it: a turn starts
  mb.setBusy(PID);
  await settle();
  assert.deepEqual(writes, [], "still held through the turn their prompt started");
  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, ["report from B", "\r"]);
});

test("a hookless agent holds for a draft too, and clearing it delivers", async () => {
  const held: number[] = [];
  const writes: string[] = [];
  const mb = new Mailbox((_id, data) => { writes.push(data); return true; }, 1, undefined, (_id, n) => held.push(n));
  mb.typed(PID, "half a thou");
  mb.deliver(PID, "one");
  mb.deliver(PID, "two");
  await settle();
  assert.deepEqual(writes, []);
  mb.typed(PID, "\x15"); // Ctrl-U
  await new Promise((r) => setTimeout(r, 2600));
  assert.deepEqual(writes.filter((w) => w !== "\r"), ["one", "two"]);
  assert.deepEqual(held, [1, 2, 1, 0]);
});

test("keys that are not a draft do not hold: mid-turn answers, terminal reports", async () => {
  const { mb, writes } = harness();
  mb.setBusy(PID);
  mb.typed(PID, "1"); // answers the agent's permission prompt
  mb.setIdle(PID);
  mb.typed(PID, "\x1b[I"); // focus report
  mb.typed(PID, "\x1b[A"); // arrow
  mb.deliver(PID, "hello");
  await settle();
  assert.deepEqual(writes, ["hello", "\r"]);
});

test("an agent that steers gets a message mid-turn at once; one that does not waits for its turn to end", async () => {
  for (const steers of [true, false]) {
    const writes: string[] = [];
    const mb = new Mailbox((_id, data) => { writes.push(data); return true; }, 1, () => steers);
    let sent = false;
    mb.setBusy(PID);
    mb.deliver(PID, "report from B", () => { sent = true; });
    await settle();
    assert.deepEqual(writes, steers ? ["report from B", "\r"] : [], `steers=${steers}`);
    assert.equal(sent, steers);
    assert.equal(mb.pending(PID), steers ? 0 : 1);
  }
});

test("a steering agent the person is typing to mid-turn is not typed over", async () => {
  const writes: string[] = [];
  const mb = new Mailbox((_id, data) => { writes.push(data); return true; }, 1, () => true);
  mb.setBusy(PID);
  mb.typed(PID, "also check the");
  mb.deliver(PID, "report from B");
  await settle();
  assert.deepEqual(writes, []);
  assert.equal(mb.pending(PID), 1);
});
