import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { SQUEEZE_OVER, squeezed } from "../src/squeeze.ts";

test("a short frame sent right after a long one arrives after it, the long one deflated and the short one as it is", async () => {
  const arrived: string[] = [];
  const channel = squeezed({ send: (t) => arrived.push(t), on: () => () => {}, closed: new Promise(() => {}) });
  const long = `{"text":"${"résumé 🐝 ".repeat(SQUEEZE_OVER)}"}`;
  channel.send(long);
  channel.send('{"id":2}');
  channel.send('{"id":3}');
  for (let i = 0; i < 100 && arrived.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  const read = arrived.map((f) => (f.startsWith("z:") ? inflateRawSync(Buffer.from(f.slice(2), "base64")).toString() : f));
  assert.deepEqual(read, [long, '{"id":2}', '{"id":3}']);
  assert.deepEqual(arrived.map((f) => f.startsWith("z:")), [true, false, false]);
});
