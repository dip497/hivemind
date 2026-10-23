// What the window's live region says (workspace/announcer.ts): what a toast and an OS notification
// tell (useAgentAwareness's noticeOf), under the same notification settings, once, after the
// tile's state has held; a status that repeats, a blip, and a tile that closed meanwhile are not said.
import { mock, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createAnnouncer } from "../../src/renderer/src/workspace/announcer.ts";
import { forgetStatus, publishStatus, subscribeStatus, type StatusEvent } from "../../src/renderer/src/agent-status-bus.ts";
import { markBackgroundTile } from "../../src/renderer/src/worker-tiles.ts";
import { setNotificationSettingsCache } from "../../src/renderer/src/notification-settings.ts";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../src/shared/notification-settings.ts";

mock.timers.enable({ apis: ["setTimeout", "Date"] });

const tiles = new Set<string>();
/** A tile's status, on the bus. */
const ev = (tileId: string, status: StatusEvent["status"], more: Partial<StatusEvent> = {}) => {
  tiles.add(tileId);
  publishStatus({ tileId, label: tileId.toUpperCase(), status, ...more });
};
/** An announcer on the status bus, as the window mounts it, and what it said. After the test the
 *  bus forgets the test's tiles, so the next test's announcer is not told of them. */
function listen(t: TestContext): string[] {
  const said: string[] = [];
  const a = createAnnouncer((text) => said.push(text));
  const off = subscribeStatus(a.onStatus);
  t.after(() => { off(); a.stop(); for (const id of tiles) forgetStatus(id); tiles.clear(); setNotificationSettingsCache(DEFAULT_NOTIFICATION_SETTINGS); });
  return said;
}

test("a tile that needs you, finished or failed is said once, with the others that changed", (t) => {
  const said = listen(t);
  ev("a1", "working"); ev("b1", "working"); ev("c1", "working"); ev("d1", "working"); ev("e1", "working"); ev("f1", "working"); ev("g1", "working");
  ev("a1", "permission");
  ev("a1", "permission", { label: "A1 renamed" }); // the same state again: no second line
  ev("b1", "idle");
  ev("c1", "exited", { exitCode: 1 });
  ev("d1", "exited", { exitCode: 0 }); // closed cleanly: finished
  ev("e1", "idle", { synthetic: true }); // interrupted, not finished
  ev("f1", "question"); ev("f1", "working"); // answered before it was said
  ev("g1", "exited"); // no code: as a toast says, it failed
  assert.deepEqual(said, [], "nothing is said before the states hold");
  mock.timers.tick(1000);
  assert.deepEqual(said, ["A1 needs you. B1 finished. C1 failed. D1 finished. G1 failed"]);

  ev("a1", "permission", { detail: "still waiting" });
  ev("b1", "idle", { detail: "turn ended" });
  mock.timers.tick(1000);
  assert.equal(said.length, 1, "a status that repeats is not said again");
});

test("a tile is told only after it changes: an exit it was not working before, a first status that is not a wait", (t) => {
  const said = listen(t);
  ev("a2", "idle"); ev("b2", "working"); ev("c2", "permission");
  ev("a2", "exited", { exitCode: 2 }); // a shell: it never said it was working
  mock.timers.tick(1000);
  assert.deepEqual(said, ["C2 needs you"], "a tile that waits for you when first seen is told, as its toast is");
});

test("a background worker's end is not said, one by one; that it needs you is", (t) => {
  const said = listen(t);
  for (const id of ["a3", "b3", "c3"]) { markBackgroundTile(id); ev(id, "working"); }
  ev("a3", "idle");
  ev("b3", "exited", { exitCode: 1 });
  ev("c3", "permission");
  mock.timers.tick(1000);
  assert.deepEqual(said, ["C3 needs you"]);
});

test("the notification settings mute it as they mute a toast", (t) => {
  const said = listen(t);
  ev("a4", "working"); ev("b4", "working");
  setNotificationSettingsCache({ ...DEFAULT_NOTIFICATION_SETTINGS, kinds: { needs: true, done: false, error: true } });
  ev("a4", "idle"); ev("b4", "permission");
  mock.timers.tick(1000);
  assert.deepEqual(said, ["B4 needs you"], "finished is off");
  setNotificationSettingsCache({ ...DEFAULT_NOTIFICATION_SETTINGS, inApp: false });
  ev("b4", "working"); ev("b4", "permission");
  mock.timers.tick(1000);
  assert.equal(said.length, 1, "in-app notices are off");
});

test("each tile is said once its own state has held: one that changed just now waits for its own time", (t) => {
  const said = listen(t);
  ev("a5", "working"); ev("b5", "working");
  ev("a5", "permission");
  mock.timers.tick(600);
  ev("b5", "idle");
  mock.timers.tick(400);
  assert.deepEqual(said, ["A5 needs you"], "B5 changed 400 ms ago");
  mock.timers.tick(1000);
  assert.deepEqual(said, ["A5 needs you", "B5 finished"]);
});

test("a tile closed before its state held is not said", (t) => {
  const said = listen(t);
  ev("a6", "working"); ev("b6", "working");
  ev("a6", "idle"); ev("b6", "idle");
  forgetStatus("a6");
  mock.timers.tick(1000);
  assert.deepEqual(said, ["B6 finished"]);
});
