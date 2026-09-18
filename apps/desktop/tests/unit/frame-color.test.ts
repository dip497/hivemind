// frameColorFor — a frame's identity colour. Pure, no React/DOM.
import { test } from "node:test";
import assert from "node:assert/strict";

const { frameColorFor, FRAME_SWATCHES, LEGACY_FRAME_COLOR, isGeneratedFrameColor } = await import(
  "../../src/renderer/src/frame-color.ts"
);

const hueOf = (c: string) => Number(/^oklch\([\d.]+ [\d.]+ ([\d.]+)\)$/.exec(c)?.[1]);

test("stable for a given id (no flicker across reloads)", () => {
  assert.equal(frameColorFor("frame-123"), frameColorFor("frame-123"));
});

test("returns a valid oklch string", () => {
  assert.match(frameColorFor("frame-abc"), /^oklch\(0\.72 0\.075 \d+(\.\d+)?\)$/);
});

test("different ids spread across multiple hues", () => {
  const hues = new Set(Array.from({ length: 40 }, (_, i) => frameColorFor(`frame-${i}`)));
  assert.ok(hues.size >= 5, `expected >=5 distinct colors, got ${hues.size}`);
});

test("no frame colour sits where a status colour does: warm means attention, green means done", () => {
  const generated = Array.from({ length: 200 }, (_, i) => frameColorFor(`frame-${i}`));
  for (const c of [...generated, ...FRAME_SWATCHES.map((s: { value: string }) => s.value)]) {
    const h = hueOf(c);
    if (Number.isNaN(h)) continue;
    assert.ok(!(h <= 110 || h >= 350), `${c} is in the warm band`);
    assert.ok(!(h >= 125 && h <= 175), `${c} is in the green band`);
  }
});

test("an earlier generated colour is migrated; a chosen one is not", () => {
  assert.equal(isGeneratedFrameColor(LEGACY_FRAME_COLOR), true);
  assert.equal(isGeneratedFrameColor("oklch(0.7 0.14 70)"), true);
  assert.equal(isGeneratedFrameColor("#f59e0b"), false);
  assert.equal(isGeneratedFrameColor(FRAME_SWATCHES[0]!.value), false);
});
