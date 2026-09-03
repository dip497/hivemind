// NDJSON framing between the pty daemon and main: lines split across chunks
// reassemble, many lines in one chunk all arrive in order, blank lines are
// skipped, and a UTF-8 sequence split across two socket reads is not mangled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLineDecoder, frame } from "../../src/main/pty-protocol.ts";

test("reassembles a line split across chunks and splits many lines in one chunk", () => {
  const lines: string[] = [];
  const feed = makeLineDecoder((l) => lines.push(l));
  feed('{"a":1');
  assert.deepEqual(lines, []);
  feed('}\n{"b":2}\n{"c"');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  feed(':3}\n\n\n{"d":4}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
});

test("a multi-byte UTF-8 character split across two Buffer chunks survives", () => {
  const lines: string[] = [];
  const feed = makeLineDecoder((l) => lines.push(l));
  const whole = Buffer.from(frame({ t: "data", id: "x", data: "héllo 🐝" }), "utf8");
  // Cut inside the 4-byte bee emoji.
  const cut = whole.indexOf(Buffer.from("🐝")) + 2;
  feed(whole.subarray(0, cut));
  feed(whole.subarray(cut));
  assert.equal(lines.length, 1);
  assert.equal((JSON.parse(lines[0]!) as { data: string }).data, "héllo 🐝");
});

test("hundreds of small frames in one chunk decode in order (linear-time path)", () => {
  const lines: string[] = [];
  const feed = makeLineDecoder((l) => lines.push(l));
  const n = 500;
  let chunk = "";
  for (let i = 0; i < n; i++) chunk += frame({ t: "data", id: "t", data: `c${i}` });
  feed(chunk);
  assert.equal(lines.length, n);
  assert.equal((JSON.parse(lines[n - 1]!) as { data: string }).data, `c${n - 1}`);
});
