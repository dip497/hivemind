// The main-process pty output coalescer: chunks batch into one message per
// tile per tick, order is preserved, the size cap flushes early, an exit
// flushes its tile first, and hidden windows get the longer delay.
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
