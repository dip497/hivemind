import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsDomRenderer } from "../../src/renderer/src/terminal-renderer-policy.ts";

const NOW = 1_000_000;

test("a tile holding a WebGL slot always renders WebGL — focused, idle, or low-DPI", () => {
  // Typing into a focused agent tile: 14.4–16.3 ms/keystroke on the DOM renderer
  // (40–60 ms once the input wraps over lines) vs 6.1–6.5 ms on WebGL —
  // docs/design/perf-streaming-2026-09-11.md (2026-09-19). DOM is only a
  // fallback; there is no DPR / selection / quietness exception.
  assert.equal(wantsDomRenderer({ now: NOW, webglCooldownUntil: 0 }), false);
});

test("a WebGL context-loss cooldown pins DOM until it expires", () => {
  assert.equal(wantsDomRenderer({ now: NOW, webglCooldownUntil: NOW + 1 }), true);
  assert.equal(wantsDomRenderer({ now: NOW - 1, webglCooldownUntil: NOW }), true);
  assert.equal(wantsDomRenderer({ now: NOW, webglCooldownUntil: NOW }), false, "stops at expiry");
});
