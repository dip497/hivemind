// frameColorFor — deterministic per-frame accent. Pure, no React/DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

const { frameColorFor, LEGACY_FRAME_COLOR } = await import(
  "../../src/renderer/src/frame-color.ts"
);

test("stable for a given id (no flicker across reloads)", () => {
  assert.equal(frameColorFor("frame-123"), frameColorFor("frame-123"));
});

test("returns a valid oklch string", () => {
  assert.match(frameColorFor("frame-abc"), /^oklch\(0\.7 0\.14 \d+(\.\d+)?\)$/);
});

test("different ids spread across multiple hues", () => {
  const hues = new Set(
    Array.from({ length: 40 }, (_, i) => frameColorFor(`frame-${i}`)),
  );
  // FNV-1a over 40 distinct ids should land on several of the 11 hue stops.
  assert.ok(hues.size >= 5, `expected >=5 distinct colors, got ${hues.size}`);
});

test("legacy default is the indigo brand var (migration sentinel)", () => {
  assert.equal(LEGACY_FRAME_COLOR, "var(--color-brand)");
});
