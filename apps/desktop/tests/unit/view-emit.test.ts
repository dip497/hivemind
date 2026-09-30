import { test } from "node:test";
import assert from "node:assert/strict";
import { EMIT_RATE, makeDispatch, parseEmit, tokenBucket } from "../../src/main/hcp/methods.ts";

test("parseEmit: a dotted name, plain JSON within limits, and who sent it", () => {
  assert.deepEqual(parseEmit({ name: "ci.build", data: { state: "failed" } }), { name: "ci.build", data: { state: "failed" }, from: "shell" });
  assert.deepEqual(parseEmit({ name: "deploy.done" }), { name: "deploy.done", data: null, from: "shell" });
  assert.deepEqual(parseEmit({ name: "a", callerTile: "hm:t1", view: "@dip497/valley" }), { name: "a", data: null, view: "@dip497/valley", from: { tileId: "t1" } });
  for (const bad of [{}, { name: "CI" }, { name: "hive.status" }, { name: "x", data: "y".repeat(5000) }, { name: "x", view: "" }]) {
    assert.throws(() => parseEmit(bad), (e: { code?: string }) => e.code === "BAD_REQUEST", JSON.stringify(bad).slice(0, 60));
  }
});

test("tokenBucket: a burst, then the steady rate", () => {
  let t = 0;
  const b = tokenBucket(EMIT_RATE, () => t);
  let ok = 0;
  for (let i = 0; i < 100; i++) if (b.take()) ok++;
  assert.equal(ok, EMIT_RATE.burst);
  t += 1000;
  ok = 0;
  for (let i = 0; i < 100; i++) if (b.take()) ok++;
  assert.equal(ok, EMIT_RATE.perSecond);
});

test("view.emit is validated in main, then handed to the renderer", async () => {
  const calls: Array<[string, unknown]> = [];
  const d = makeDispatch({ callRenderer: async (m: string, p: unknown) => { calls.push([m, p]); return { ok: true, delivered: false }; } } as unknown as Parameters<typeof makeDispatch>[0]);
  assert.deepEqual(await d.dispatch("view.emit", { name: "ci.build", data: [1] }), { ok: true, delivered: false });
  assert.deepEqual(calls, [["view.emit", { name: "ci.build", data: [1], from: "shell" }]]);
  await assert.rejects(d.dispatch("view.emit", { name: "Bad" }), (e: { code?: string }) => e.code === "BAD_REQUEST");
  assert.equal(calls.length, 1);
});
