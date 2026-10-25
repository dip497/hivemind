// The built-in sounds and the loudness cap every sound goes through (renderer/src/sounds). Both are
// sample math, so they are read here from the samples a window would play: no audio context
// needed, and none is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_RATE, synth } from "../../src/renderer/src/sounds/synth.ts";
import { leveled } from "../../src/renderer/src/sounds/level.ts";

/** −6 dBFS, the loudest any sound here plays: the cap is the contract, so it is spelt out. */
const MINUS_6_DBFS = 0.5011872;

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** The pitch between `from` and `to` seconds, from how often the wave crosses zero going up. */
function pitch(x: Float32Array, from: number, to: number): number {
  let ups = 0;
  for (let i = Math.floor(from * SAMPLE_RATE) + 1; i < to * SAMPLE_RATE; i++) if (x[i - 1]! < 0 && x[i]! >= 0) ups++;
  return ups / (to - from);
}

test("the built-in sounds: their length, their pitch moving the right way, and a peak of -6 dBFS", () => {
  const needs = synth("needs");
  const done = synth("done");
  const error = synth("error");
  assert.deepEqual([needs, done, error].map((x) => Math.round((x.length / SAMPLE_RATE) * 100) / 100), [0.31, 0.61, 0.45]);
  for (const x of [needs, done, error]) assert.ok(Math.abs(peak(x) - MINUS_6_DBFS) < 1e-6, `peak ${peak(x)}`);
  // Needs you rises from E5 to A5; failed falls from A3 to E3; finished rings at A5.
  assert.ok(Math.abs(pitch(needs, 0.01, 0.085) - 659) < 30 && Math.abs(pitch(needs, 0.1, 0.175) - 880) < 30, "E5 then A5");
  assert.ok(Math.abs(pitch(error, 0.01, 0.12) - 220) < 20 && Math.abs(pitch(error, 0.16, 0.27) - 165) < 20, "A3 then E3");
  assert.ok(Math.abs(pitch(done, 0.01, 0.3) - 880) < 40, "A5");
  // Its tail has died away by its end.
  assert.ok(peak(done.subarray(done.length - 200)) < 0.01);
});

test("a theme's sound is cut to 3 s and leveled to the built-ins' -6 dBFS, louder or quieter, on every channel", () => {
  const rate = 48_000;
  const loud = [new Float32Array(5 * rate).fill(1), new Float32Array(5 * rate).fill(-0.5)];
  const out = leveled(loud, rate);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.length, 3 * rate, "a 5 s sound is cut to 3 s");
  assert.ok(Math.abs(peak(out[0]!) - MINUS_6_DBFS) < 1e-6);
  assert.ok(Math.abs(out[1]![rate] + MINUS_6_DBFS / 2) < 1e-6, "the channels keep their balance");
  assert.equal(out[0]!.at(-1), 0, "a cut fades out");
  const quiet = leveled([new Float32Array(rate).fill(0.01)], rate);
  assert.ok(Math.abs(peak(quiet[0]!) - MINUS_6_DBFS) < 1e-6);
  assert.equal(quiet[0]!.length, rate, "a short sound keeps its length");
  assert.equal(peak(leveled([new Float32Array(rate)], rate)[0]!), 0, "silence stays silence");
});
