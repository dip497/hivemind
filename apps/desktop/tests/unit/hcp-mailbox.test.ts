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

test("two messages typed at once into one tile are each sent alone: the second waits for the first's Enter", async () => {
  // Typed between the first's text and its Enter, the second was glued to it and its own Enter
  // sent an empty line: a phone's "/clear" then "a fresh start" reached the agent as
  // "/cleara fresh start".
  const { mb, writes } = harness();
  assert.equal(mb.deliver("hm:tile-codex-9", "/clear"), true);
  assert.equal(mb.deliver("hm:tile-codex-9", "a fresh start"), true);
  await settle();
  assert.deepEqual(writes, ["/clear", "\r", "a fresh start", "\r"]);
});

test("dead tile while idle reports failure (so agent.send can raise NOT_FOUND)", () => {
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

test("a line sent in one write with its Enter is no draft: a message after it is not held", async () => {
  const { mb, writes } = harness();
  mb.typed(PID, "fix the nav\r"); // a pasted line, or a phone's, Enter and all
  mb.deliver(PID, "ship it");
  await settle();
  assert.deepEqual(writes, ["ship it", "\r"]);

  mb.typed(PID, "run them\rand th"); // sent, then the start of another
  mb.deliver(PID, "report");
  await settle();
  assert.deepEqual(writes, ["ship it", "\r"], "held for what is typed after the Enter");
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

test("photos for an agent that attaches a pasted path: each path pasted alone, then the words, then Enter; one held keeps them", async () => {
  const { mb, writes } = harness();
  mb.deliver(PID, "what is wrong here?", undefined, { pasted: ["/p/a.png", "/p/b.png"] });
  await settle();
  assert.deepEqual(writes, ["/p/a.png", "/p/b.png", " what is wrong here?", "\r"]);
  writes.length = 0;
  mb.setBusy(PID);
  mb.deliver(PID, "", undefined, { pasted: ["/p/c.png"] });
  mb.deliver(PID, "and this");
  await settle();
  assert.deepEqual(writes, []);
  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, ["/p/c.png", "\r"], "a photo with no words is sent alone");
  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, ["/p/c.png", "\r", "and this", "\r"], "in the order sent");
});

/** A hooked agent whose file says how its empty prompt reads: `screen.words` is what its prompt
 *  shows before the cursor. */
function screenHarness() {
  const writes: string[] = [];
  const screen = { words: "" };
  const mb = new Mailbox((_id, data) => { writes.push(data); return true; }, 1, undefined, undefined, undefined,
    async () => screen.words === "");
  mb.setBusy(PID); mb.setIdle(PID);
  return { mb, writes, screen };
}

test("a draft cleared with keys that say nothing (Esc Esc): a message after it is typed, not held for an Enter", async () => {
  const { mb, writes, screen } = screenHarness();
  mb.typed(PID, "when we crawl"); screen.words = "when we crawl";
  mb.typed(PID, "\x1b"); mb.typed(PID, "\x1b"); screen.words = "";
  mb.deliver(PID, "from the phone");
  await settle();
  assert.deepEqual(writes, ["from the phone", "\r"]);
});

test("a draft deleted key by key while a message waits: it goes once the person stops typing", async () => {
  const { mb, writes, screen } = screenHarness();
  mb.typed(PID, "ab"); screen.words = "ab";
  mb.deliver(PID, "from the phone");
  await settle();
  assert.deepEqual(writes, [], "held while the person has words there");
  mb.typed(PID, "\x7f"); mb.typed(PID, "\x7f"); screen.words = "";
  await new Promise((r) => setTimeout(r, 1400));
  assert.deepEqual(writes, ["from the phone", "\r"]);
});

test("words typed while the agent works hold what waits for its prompt, instead of being sent glued to it", async () => {
  const { mb, writes, screen } = screenHarness();
  mb.setBusy(PID);
  mb.deliver(PID, "Hello");
  mb.typed(PID, "check ssh"); screen.words = "check ssh";
  mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, [], "not typed after the person's words");
  assert.equal(mb.pending(PID), 1);

  mb.typed(PID, "\r"); screen.words = ""; // they send theirs: a turn runs
  mb.setBusy(PID); mb.setIdle(PID);
  await settle();
  assert.deepEqual(writes, ["Hello", "\r"]);
});

test("what the agent itself shows at its prompt holds nothing: only the person's words do", async () => {
  const { mb, writes, screen } = screenHarness();
  screen.words = "/resume";
  mb.deliver(PID, "report");
  await settle();
  assert.deepEqual(writes, ["report", "\r"]);
});

test("a steering agent the person typed to earlier in its turn is not typed over, however long ago", async () => {
  const writes: string[] = [];
  const mb = new Mailbox((_id, data) => { writes.push(data); return true; }, 1, () => true);
  mb.setBusy(PID);
  mb.typed(PID, "check ssh");
  await new Promise((r) => setTimeout(r, 5200));
  mb.deliver(PID, "Hello");
  await settle();
  assert.deepEqual(writes, [], "not glued to the person's words");
  assert.equal(mb.pending(PID), 1);
});

test("an Enter the agent drops while it attaches a photo is pressed again until its turn begins, and no more", async () => {
  // Its screen: what was typed waits at the prompt; the first Enter is dropped, the next sends.
  const writes: string[] = [];
  const screen = { words: "", drops: 1 };
  const mb = new Mailbox((_id, data) => {
    writes.push(data);
    if (data !== "\r") screen.words += data;
    else if (screen.drops-- <= 0) { screen.words = ""; mb.setBusy(PID); }
    return true;
  }, 1, undefined, undefined, () => true, async () => screen.words === "");
  mb.setBusy(PID); mb.setIdle(PID);
  await settle();
  mb.deliver(PID, "what is wrong here?", undefined, { pasted: ["/p/a.png"] });
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepEqual(writes, ["/p/a.png", " what is wrong here?", "\r", "\r"]);
  assert.equal(screen.words, "");
});

test("an Enter is not pressed again over the person's own typing", async () => {
  const writes: string[] = [];
  const screen = { words: "" };
  const mb = new Mailbox((_id, data) => {
    writes.push(data);
    if (data !== "\r") screen.words += data;
    return true;
  }, 1, undefined, undefined, () => true, async () => screen.words === "");
  mb.setBusy(PID); mb.setIdle(PID);
  await settle();
  mb.deliver(PID, "look", undefined, { pasted: ["/p/a.png"] });
  await settle();
  mb.typed(PID, "x");
  await new Promise((r) => setTimeout(r, 2000));
  assert.deepEqual(writes, ["/p/a.png", " look", "\r"]);
});
