import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsDomRenderer, STREAM_QUIET_MS } from "../../src/renderer/src/terminal-renderer-policy.ts";

const NOW = 1_000_000;
const base = { dpr: 1, now: NOW, lastStreamTs: NOW, selected: false, webglCooldownUntil: 0 };

test("the selected tile is always DOM, even while it streams", () => {
  assert.equal(wantsDomRenderer({ ...base, selected: true, lastStreamTs: NOW }), true);
  assert.equal(wantsDomRenderer({ ...base, selected: true, lastStreamTs: 0 }), true);
});

test("an unselected tile is WebGL while streaming and DOM once quiet", () => {
  assert.equal(wantsDomRenderer({ ...base, lastStreamTs: NOW }), false);
  assert.equal(wantsDomRenderer({ ...base, lastStreamTs: NOW - STREAM_QUIET_MS }), false, "exactly at the threshold is still streaming");
  assert.equal(wantsDomRenderer({ ...base, lastStreamTs: NOW - STREAM_QUIET_MS - 1 }), true);
});

test("a HiDPI screen always uses WebGL — there is no sharpness trade to make", () => {
  assert.equal(wantsDomRenderer({ ...base, dpr: 2, selected: true, lastStreamTs: 0 }), false);
  assert.equal(wantsDomRenderer({ ...base, dpr: 3, lastStreamTs: 0 }), false);
});

test("a WebGL context-loss cooldown wins over everything", () => {
  assert.equal(wantsDomRenderer({ ...base, lastStreamTs: NOW, webglCooldownUntil: NOW + 1 }), true);
  assert.equal(wantsDomRenderer({ ...base, dpr: 3, webglCooldownUntil: NOW + 1 }), true);
  assert.equal(wantsDomRenderer({ ...base, lastStreamTs: NOW, webglCooldownUntil: NOW }), false, "stops at expiry");
});
