// Unit tests for the agent status bus — the dedupe gate is the real logic
// (the poll re-asserts the same status every tick; only transitions must fire).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  publishStatus,
  subscribeStatus,
  clearStatus,
} from "../../src/renderer/src/agent-status-bus.ts";

test("subscribers receive published events", () => {
  const seen: string[] = [];
  const off = subscribeStatus((e) => seen.push(`${e.tileId}:${e.status}`));
  publishStatus({ tileId: "t1", label: "claude", status: "working" });
  publishStatus({ tileId: "t1", label: "claude", status: "idle" });
  off();
  assert.deepEqual(seen, ["t1:working", "t1:idle"]);
});

test("identical status+label is deduped (no repeat events)", () => {
  clearStatus("t2");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t2") count++; });
  publishStatus({ tileId: "t2", label: "codex", status: "working" });
  publishStatus({ tileId: "t2", label: "codex", status: "working" }); // dup
  publishStatus({ tileId: "t2", label: "codex", status: "blocked" }); // change
  off();
  assert.equal(count, 2);
});

test("clearStatus resets the dedupe memory", () => {
  clearStatus("t3");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t3") count++; });
  publishStatus({ tileId: "t3", label: "amp", status: "idle" });
  clearStatus("t3");
  publishStatus({ tileId: "t3", label: "amp", status: "idle" }); // fires again after clear
  off();
  assert.equal(count, 2);
});

test("unsubscribe stops delivery", () => {
  clearStatus("t4");
  let count = 0;
  const off = subscribeStatus((e) => { if (e.tileId === "t4") count++; });
  publishStatus({ tileId: "t4", label: "grok", status: "working" });
  off();
  publishStatus({ tileId: "t4", label: "grok", status: "idle" });
  assert.equal(count, 1);
});
