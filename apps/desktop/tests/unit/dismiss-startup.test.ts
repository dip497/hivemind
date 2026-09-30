// The host answers a startup screen the launch flags already answered — and stops there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISMISS_MAX, DISMISS_WINDOW_MS, mayDismiss, newDismissState } from "../../src/renderer/src/dismiss-startup.ts";

test("only at the start, only before the person touches the tile, only twice", () => {
  const t0 = 1_000_000;
  const s = newDismissState(t0);
  assert.equal(mayDismiss(s, t0), true);
  assert.equal(mayDismiss(s, t0 + DISMISS_WINDOW_MS - 1), true);
  // A screen that keeps coming back is the agent's business, not ours.
  assert.equal(mayDismiss(s, t0 + DISMISS_WINDOW_MS), false);

  const spent = { ...newDismissState(t0), left: 0 };
  assert.equal(mayDismiss(spent, t0), false);
  assert.equal(DISMISS_MAX, 2);

  // Once the person has typed, the tile is theirs: nothing is sent into it again.
  const touched = { ...newDismissState(t0), touched: true };
  assert.equal(mayDismiss(touched, t0), false);
});
