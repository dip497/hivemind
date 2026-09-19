// The main-process pty output coalescer: chunks batch into one message per
// tile per tick, order is preserved, the size cap flushes early, an exit
// flushes its tile first, hidden windows get the longer delay, and a small
// echo right after user input skips the wait entirely (interactive fast path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyOutputBuffer } from "../../src/main/pty-output-buffer.ts";

/** Manual timer: tests fire the pending flush themselves. */
function fakeTimers() {
  let pending: { fn: () => void; ms: number } | null = null;
  return {
    setTimer: (fn: () => void, ms: number) => { pending = { fn, ms }; return 1; },
    clearTimer: () => { pending = null; },
    fire: () => { const p = pending; pending = null; p?.fn(); },
    scheduledMs: () => pending?.ms ?? null,
  };
}

/** Manual clock: tests advance time past the interactive window themselves. */
function fakeClock() {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

test("coalesces a tile's chunks into one send per tick, preserving order", () => {
  const t = fakeTimers();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, ...t });
  b.push("a", "hel");
  b.push("a", "lo ");
  b.push("b", "x");
  b.push("a", "world");
  assert.deepEqual(sent, [], "nothing ships before the timer");
  assert.equal(t.scheduledMs(), 8);
  t.fire();
  assert.deepEqual(sent, [["a", "hello world"], ["b", "x"]]);
  assert.equal(b.pendingBytes("a"), 0);
});

test("size cap ships a tile immediately (memory + latency bound when timers starve)", () => {
  const t = fakeTimers();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { maxBytes: 10, ...t });
  b.push("a", "12345");
  b.push("a", "67890");
  assert.deepEqual(sent, [["a", "1234567890"]], "crossing the cap flushes at once, in order");
  t.fire();
  assert.equal(sent.length, 1);
});

test("flush(tile) ships that tile now and leaves the others queued", () => {
  const t = fakeTimers();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), t);
  b.push("a", "A");
  b.push("b", "B");
  b.flush("a");
  assert.deepEqual(sent, [["a", "A"]]);
  assert.equal(b.pendingBytes("b"), 1);
  t.fire();
  assert.deepEqual(sent, [["a", "A"], ["b", "B"]]);
});

test("forget drops pending output without sending; empty buffer cancels the timer", () => {
  const t = fakeTimers();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), t);
  b.push("a", "A");
  b.forget("a");
  assert.equal(t.scheduledMs(), null, "timer cancelled once nothing is pending");
  t.fire();
  assert.deepEqual(sent, []);
});

test("hidden window → the longer flush delay", () => {
  const t = fakeTimers();
  let hidden = false;
  const b = new PtyOutputBuffer(() => {}, { delayMs: 8, hiddenDelayMs: 200, hidden: () => hidden, ...t });
  b.push("a", "A");
  assert.equal(t.scheduledMs(), 8);
  t.fire();
  hidden = true;
  b.push("a", "B");
  assert.equal(t.scheduledMs(), 200);
});

test("empty chunks are ignored", () => {
  const t = fakeTimers();
  const b = new PtyOutputBuffer(() => {}, t);
  b.push("a", "");
  assert.equal(t.scheduledMs(), null);
});

test("clear drops everything and cancels the timer", () => {
  const t = fakeTimers();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), t);
  b.push("a", "A");
  b.push("b", "B");
  b.clear();
  assert.equal(t.scheduledMs(), null);
  t.fire();
  assert.deepEqual(sent, []);
  assert.equal(b.pendingBytes("a"), 0);
});

test("interactive: a small echo right after markInput ships synchronously", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, now: clock.now, ...t });
  b.markInput("a");
  b.push("a", "echo");
  assert.deepEqual(sent, [["a", "echo"]], "out at once, no timer wait");
  assert.equal(t.scheduledMs(), null, "no timer was ever needed");
  assert.equal(b.pendingBytes("a"), 0);
});

test("interactive fast path sends pending bytes first, in the same message", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, now: clock.now, ...t });
  b.push("a", "queued");
  b.markInput("a");
  b.push("a", "echo");
  assert.deepEqual(sent, [["a", "queuedecho"]], "pending leads new, one message");
});

test("after the interactive window expires, output batches again", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, interactiveWindowMs: 100, now: clock.now, ...t });
  b.markInput("a");
  clock.advance(101);
  b.push("a", "late");
  assert.deepEqual(sent, [], "stale mark → normal batching");
  assert.equal(t.scheduledMs(), 8);
  t.fire();
  assert.deepEqual(sent, [["a", "late"]]);
});

test("interactive fast path is skipped once pending+new exceed interactiveMaxBytes", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, interactiveMaxBytes: 10, now: clock.now, ...t });
  b.push("a", "12345678");
  b.markInput("a");
  b.push("a", "901"); // 11 bytes together > 10
  assert.deepEqual(sent, [], "oversized echo batches like any other output");
  assert.equal(b.pendingBytes("a"), 11);
  t.fire();
  assert.deepEqual(sent, [["a", "12345678901"]]);
});

test("hidden window → no interactive fast path, the stretch delay still applies", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  let hidden = true;
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), {
    delayMs: 8, hiddenDelayMs: 200, hidden: () => hidden, now: clock.now, ...t,
  });
  b.markInput("a");
  b.push("a", "echo");
  assert.deepEqual(sent, []);
  assert.equal(t.scheduledMs(), 200, "hidden stretch, not the fast path");
  hidden = false;
  b.markInput("a");
  b.push("a", " again");
  assert.deepEqual(sent, [["a", "echo again"]], "visible again → fast path ships pending+new as one message");
});

test("a tile without markInput is unaffected while another tile is interactive", () => {
  const t = fakeTimers();
  const clock = fakeClock();
  const sent: [string, string][] = [];
  const b = new PtyOutputBuffer((id, d) => sent.push([id, d]), { delayMs: 8, now: clock.now, ...t });
  b.markInput("fast");
  b.push("fast", "now");
  b.push("slow", "later");
  assert.deepEqual(sent, [["fast", "now"]], "only the marked tile fast-paths");
  assert.equal(b.pendingBytes("slow"), 5);
  t.fire();
  assert.deepEqual(sent, [["fast", "now"], ["slow", "later"]]);
});
