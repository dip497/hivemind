import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPtySize } from "../../src/renderer/src/pty-size-sync";

test("sends the size when the pty has never been told one", () => {
  assert.deepEqual(nextPtySize(null, 170, 44), { cols: 170, rows: 44 });
});

test("says nothing when the pty already has this size", () => {
  assert.equal(nextPtySize({ cols: 170, rows: 44 }, 170, 44), null);
});

// The bug this exists for: a fit whose cols land where the grid already was
// emits no xterm onResize, so before this the pty kept whatever it drifted to
// (a re-attach's frozen spec, another mount's resize) and wrapped at that width
// while the grid rendered at 106 — long lines ran off the right edge.
test("re-sends after the pty drifted, even though the grid did not move", () => {
  let sent = nextPtySize(null, 106, 30);
  assert.deepEqual(sent, { cols: 106, rows: 30 });
  // The session comes back at its old size; the grid is still 106 wide.
  sent = nextPtySize({ cols: 170, rows: 44 }, 106, 30);
  assert.deepEqual(sent, { cols: 106, rows: 30 });
});

test("a re-fit at a new width is sent", () => {
  assert.deepEqual(nextPtySize({ cols: 106, rows: 30 }, 170, 44), { cols: 170, rows: 44 });
});

test("never resizes a session to nothing while the host is unlaid-out", () => {
  for (const [cols, rows] of [[0, 30], [106, 0], [-1, 30], [NaN, 30], [106, NaN]]) {
    assert.equal(nextPtySize({ cols: 106, rows: 30 }, cols as number, rows as number), null);
  }
});
