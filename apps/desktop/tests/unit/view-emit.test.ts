import { test } from "node:test";
import assert from "node:assert/strict";
import { EMIT_RATE, makeDispatch, parseEmit, tokenBucket } from "@hivemind/host/control/methods";

test("parseEmit: a dotted name, plain JSON within limits, and who sent it", () => {
  assert.deepEqual(parseEmit("ci.build", { state: "failed" }, undefined), { name: "ci.build", data: { state: "failed" }, from: "shell" });
  assert.deepEqual(parseEmit("deploy.done", undefined, null), { name: "deploy.done", data: null, from: "shell" });
  assert.deepEqual(parseEmit("a", undefined, "@dip497/valley", "t1"), { name: "a", data: null, view: "@dip497/valley", from: { tileId: "t1" } });
  for (const bad of [[undefined], ["CI"], ["hive.status"], ["x", "y".repeat(5000)], ["x", null, ""]]) {
    assert.throws(() => parseEmit(bad[0], bad[1], bad[2]), (e: { code?: string }) => e.code === "BAD_REQUEST", JSON.stringify(bad).slice(0, 60));
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
  assert.deepEqual(await d.api.viewEmit(undefined, "ci.build", [1], undefined), { ok: true, delivered: false });
  assert.deepEqual(calls, [["view.emit", { name: "ci.build", data: [1], from: "shell" }]]);
  await assert.rejects(d.api.viewEmit(undefined, "Bad", null, undefined), (e: { code?: string }) => e.code === "BAD_REQUEST");
  assert.equal(calls.length, 1);
});
