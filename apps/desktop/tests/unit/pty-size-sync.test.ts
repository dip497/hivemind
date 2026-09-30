import { test } from "node:test";
import assert from "node:assert/strict";
import { drawnSize, nextPtySize, scaleToFit } from "../../src/renderer/src/pty-size-sync";

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

// Two windows showing one session, of different sizes (R4's "Done when"): the one whose size the
// session has fills its tile; the other draws the session at that size, letterboxed or scaled down.
test("a window whose size the session took draws what fits its tile, even while its next size is on the way", () => {
  const own = { cols: 120, rows: 40 };
  assert.equal(drawnSize(own, [{ cols: 100, rows: 30 }, own], { cols: 100, rows: 30 }), own);
  assert.equal(drawnSize(own, [own], own), own);
});

test("a window whose size the session did not take draws the session at the size it was given", () => {
  const given = { cols: 100, rows: 30 };
  assert.deepEqual(drawnSize({ cols: 120, rows: 40 }, [{ cols: 120, rows: 40 }], given), given);
  assert.deepEqual(drawnSize({ cols: 80, rows: 24 }, [], given), given);
  // As wide as this window asked, but not as tall: still someone else's size.
  assert.deepEqual(drawnSize({ cols: 100, rows: 40 }, [{ cols: 100, rows: 40 }], given), given);
});

test("with no size heard, a window draws what fits its tile", () => {
  const own = { cols: 80, rows: 24 };
  assert.equal(drawnSize(own, [], null), own);
});

test("a session larger than the tile is scaled down to fit it, by the tighter of its two sides; a smaller one is letterboxed", () => {
  assert.equal(scaleToFit({ cols: 100, rows: 30 }, { cols: 200, rows: 40 }), 0.5);
  assert.equal(scaleToFit({ cols: 100, rows: 30 }, { cols: 120, rows: 60 }), 0.5);
  assert.equal(scaleToFit({ cols: 100, rows: 30 }, { cols: 80, rows: 24 }), 1);
});

