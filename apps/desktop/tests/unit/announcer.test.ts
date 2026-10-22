// What the window's live region says (workspace/announcer.ts): a tile that comes to need you,
// finishes or fails is said once, after it settles; statuses that repeat, blips and a tile's first
// status are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createAnnouncer } from "../../src/renderer/src/workspace/announcer.ts";
import type { StatusEvent } from "../../src/renderer/src/agent-status-bus.ts";

/** Longer than the announcer waits for a state to settle. */
const SETTLED_MS = 1000;

test("a tile that needs you, finished or failed is said once, together with the others that changed", async () => {
  const said: string[] = [];
  const a = createAnnouncer((t) => said.push(t));
  const ev = (tileId: string, status: StatusEvent["status"], more: Partial<StatusEvent> = {}) => a.onStatus({ tileId, label: tileId.toUpperCase(), status, ...more });

  // Where each tile is as the window opens: not news.
  ev("a", "working"); ev("b", "working"); ev("c", "working"); ev("d", "working"); ev("e", "working"); ev("f", "working"); ev("g", "permission");
  ev("a", "permission");
  ev("a", "permission", { label: "A renamed" }); // the same state again: no second line
  ev("b", "idle");
  ev("c", "exited", { exitCode: 1 });
  ev("d", "exited", { exitCode: 0 });
  ev("e", "idle", { synthetic: true }); // interrupted, not finished
  ev("f", "question"); ev("f", "working"); // answered before it was said
  assert.deepEqual(said, [], "nothing is said before the states settle");
  await sleep(SETTLED_MS);
  assert.deepEqual(said, ["A needs you. B finished. C failed. D finished"]);

  ev("a", "permission", { detail: "still waiting" });
  ev("b", "idle");
  await sleep(SETTLED_MS);
  assert.equal(said.length, 1, "a status that repeats is not said again");
  a.stop();
});
