import { test } from "node:test";
import assert from "node:assert/strict";
import { rangeFor } from "./byte-range.mjs";

test("a seek gets exactly the bytes it asked for", () => {
  assert.deepEqual(rangeFor("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(rangeFor("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(rangeFor("bytes=900-5000", 1000), { start: 900, end: 999 });
  assert.deepEqual(rangeFor("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(rangeFor("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("no range, or one we do not answer, sends the whole file; one past the end is refused", () => {
  for (const h of [undefined, "", "bytes=-", "items=0-1", "bytes=0-1,5-9"]) assert.equal(rangeFor(h, 1000), null, String(h));
  for (const h of ["bytes=1000-", "bytes=500-100", "bytes=-0"]) assert.equal(rangeFor(h, 1000), false, h);
});
