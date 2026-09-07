// The per-tile status subscription the view contract exposes
// (commands.subscribeTileStatus): replay on subscribe, one tile's transitions
// only, no re-emit for an unchanged status, clean unsubscribe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { publishStatus, subscribeTileStatus, subscribeStatus, clearStatus, statusOf } from "../../src/renderer/src/agent-status-bus.ts";

test("subscribeTileStatus replays the last status and then delivers only that tile's transitions", () => {
  publishStatus({ tileId: "a", label: "a", status: "idle" });
  publishStatus({ tileId: "b", label: "b", status: "working" });
  const seen: string[] = [];
  const off = subscribeTileStatus("a", (e) => seen.push(`${e.tileId}:${e.status}`));
  assert.deepEqual(seen, ["a:idle"], "replayed synchronously on subscribe");
  publishStatus({ tileId: "b", label: "b", status: "idle" }); // other tile → ignored
  publishStatus({ tileId: "a", label: "a", status: "idle" }); // same status → no emit
  publishStatus({ tileId: "a", label: "a", status: "working" });
  assert.deepEqual(seen, ["a:idle", "a:working"]);
  off();
  publishStatus({ tileId: "a", label: "a", status: "blocked" });
  assert.deepEqual(seen, ["a:idle", "a:working"], "nothing after unsubscribe");
  assert.equal(statusOf("a"), "blocked");
  clearStatus("a"); clearStatus("b");
});

test("a tile with no status yet replays nothing; the global bus still sees everything", () => {
  const seen: string[] = [];
  const off = subscribeTileStatus("fresh", (e) => seen.push(e.status));
  assert.deepEqual(seen, []);
  const all: string[] = [];
  const offAll = subscribeStatus((e) => { if (e.tileId === "fresh" || e.tileId === "other") all.push(`${e.tileId}:${e.status}`); });
  publishStatus({ tileId: "other", label: "o", status: "working" });
  publishStatus({ tileId: "fresh", label: "f", status: "working" });
  assert.deepEqual(seen, ["working"]);
  assert.deepEqual(all, ["other:working", "fresh:working"]);
  off(); offAll();
  clearStatus("fresh"); clearStatus("other");
});
