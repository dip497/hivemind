import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLAY_MAX, RING_MAX, RING_MAX_AGE_MS, ViewEventHub, type HubTile, type LedgerLine } from "../../src/renderer/src/workspace/view-events";
import type { ViewEvent } from "@hivemind/view-sdk/protocol";
import { CommunityLink } from "@hivemind/view-host/link";

function harness() {
  let clock = 1_000_000;
  const timers: Array<() => void> = [];
  const lines: LedgerLine[] = [];
  const hub = new ViewEventHub({
    now: () => clock,
    schedule: (fn) => { timers.push(fn); },
    ledger: (ls) => lines.push(...ls),
    isAgentKind: (k) => k === "claude",
  });
  const events: ViewEvent[] = [];
  hub.subscribe((e) => { events.push(e); return e.kind === "custom"; });
  const runTimers = () => { while (timers.length) timers.shift()!(); };
  const tile = (id: string, kind = "claude"): HubTile => ({ id, frameId: "f1", kind, name: id });
  return { hub, events, lines, runTimers, tile, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

test("since: tiles present at start are lower bounds; a tile opened now is exact; a bucket change is exact", () => {
  const h = harness();
  h.hub.onStatus({ tileId: "old", label: "", status: "blocked" });
  h.hub.setWorkspace("ws", [h.tile("old")]);
  assert.equal(h.hub.sinceOf("old")!.exact, false);
  h.tick(1000);
  h.hub.setWorkspace("ws", [h.tile("old"), h.tile("new")]);
  h.hub.onStatus({ tileId: "new", label: "", status: "working" });
  assert.deepEqual(h.hub.sinceOf("new"), { bucket: "working", since: h.now(), exact: true });
  h.tick(500);
  h.hub.onStatus({ tileId: "old", label: "", status: "idle" });
  assert.deepEqual(h.hub.sinceOf("old"), { bucket: "idle", since: h.now(), exact: true });
});

test("since: permission → question stays one blocked span, and emits a second needsInput", () => {
  const h = harness();
  h.hub.setWorkspace("ws", [h.tile("t")]);
  h.hub.onStatus({ tileId: "t", label: "", status: "permission" });
  const start = h.hub.sinceOf("t")!.since;
  h.tick(2000);
  h.hub.onStatus({ tileId: "t", label: "", status: "question" });
  assert.equal(h.hub.sinceOf("t")!.since, start);
  assert.deepEqual(h.events.filter((e) => e.kind === "needsInput").map((e) => (e as { reason: string }).reason), ["permission", "question"]);
});

test("seed: a reload keeps main's exact start for a tile whose bucket did not change", () => {
  const h = harness();
  h.hub.seed([{ id: "t", bucket: "blocked", since: 5, exact: true }, { id: "u", bucket: "idle", since: 6, exact: true }]);
  h.hub.setWorkspace("ws", [h.tile("t"), h.tile("u")]);
  h.hub.onStatus({ tileId: "t", label: "", status: "permission" });
  h.hub.onStatus({ tileId: "u", label: "", status: "working" });
  assert.deepEqual(h.hub.sinceOf("t"), { bucket: "blocked", since: 5, exact: true });
  assert.equal(h.hub.sinceOf("u")!.exact, false);
});

test("turns: a hook turn is reported; an agent without hooks gets inferred ones, but not from a staleness decay or a shell", () => {
  const h = harness();
  h.hub.setWorkspace("ws", [h.tile("hooked"), h.tile("plain"), h.tile("sh", "shell")]);
  for (const id of ["hooked", "plain", "sh"]) h.hub.onStatus({ tileId: id, label: "", status: "working" });
  h.hub.onHookTurn("hooked");
  h.hub.onStatus({ tileId: "hooked", label: "", status: "idle" });
  h.hub.onStatus({ tileId: "plain", label: "", status: "idle" });
  h.hub.onStatus({ tileId: "sh", label: "", status: "idle" });
  h.hub.onStatus({ tileId: "plain", label: "", status: "working" });
  h.hub.onStatus({ tileId: "plain", label: "", status: "idle", synthetic: true });
  const turns = h.events.filter((e) => e.kind === "turn") as Array<{ tileId: string; inferred?: boolean }>;
  assert.deepEqual(turns.map((e) => [e.tileId, !!e.inferred]), [["hooked", false], ["plain", true]]);
});

test("lifecycle: opened after start is an event with its parent; closing reports the last bucket and a failed exit", () => {
  const h = harness();
  h.hub.setWorkspace("ws", [h.tile("a")]);
  assert.equal(h.events.length, 0);
  h.hub.setWorkspace("ws", [h.tile("a"), h.tile("b")], [{ parent: "a", child: "b" }]);
  assert.deepEqual(h.events.at(-1), { kind: "tileOpened", tileId: "b", frameId: "f1", tileKind: "claude", spawnedBy: "a", seq: 1, at: h.now() });
  h.hub.onStatus({ tileId: "b", label: "", status: "exited", exitCode: 2 });
  h.hub.setWorkspace("ws", [h.tile("a")]);
  assert.deepEqual(h.events.at(-1), { kind: "tileClosed", tileId: "b", lastStatus: "exited", failed: true, seq: 2, at: h.now() });
  assert.equal(h.hub.sinceOf("b"), undefined);
});

test("a workspace switch is not a mass close", () => {
  const h = harness();
  h.hub.setWorkspace("ws1", [h.tile("a")]);
  h.hub.setWorkspace("ws2", [h.tile("z")]);
  assert.deepEqual(h.events, []);
});

test("subagents coalesce to the last count per window and drop no-op windows", () => {
  const h = harness();
  h.hub.onSubagents("t", 1);
  h.hub.onSubagents("t", 2);
  h.hub.onSubagents("t", 3);
  h.runTimers();
  h.hub.onSubagents("t", 4);
  h.hub.onSubagents("t", 3);
  h.runTimers();
  const counts = h.events.filter((e) => e.kind === "subagents").map((e) => (e as { active: number }).active);
  assert.deepEqual(counts, [3]);
});

test("custom events report delivery; the ring replays at most REPLAY_MAX, none older than an hour", () => {
  const h = harness();
  const r = h.hub.emitCustom("ci.build", { state: "failed" }, "shell");
  assert.equal(r.delivered, true);
  assert.match(r.event.id, /^ev_/);
  for (let i = 0; i < RING_MAX + 20; i++) h.hub.onHookTurn("t");
  assert.equal(h.hub.replay(0).length, REPLAY_MAX);
  assert.equal(h.hub.replay(0, (e) => e.kind === "custom").length, 0); // pushed out of the ring
  h.tick(RING_MAX_AGE_MS + 1);
  assert.equal(h.hub.replay(0).length, 0);
});

test("ledger: lines are batched with the workspace key; a transient workspace records nothing", () => {
  const h = harness();
  h.hub.setWorkspace(null, [h.tile("a")]);
  h.hub.onStatus({ tileId: "a", label: "", status: "working" });
  h.runTimers();
  assert.equal(h.lines.length, 0);
  h.hub.setWorkspace("ws", [h.tile("b")]);
  h.hub.onStatus({ tileId: "b", label: "", status: "working" });
  h.hub.onHookTurn("b");
  h.hub.setWorkspace("ws", [{ ...h.tile("b"), unwatched: true }]);
  assert.equal(h.lines.length, 0); // not flushed yet
  h.runTimers();
  assert.deepEqual(h.lines.map((l) => `${l.k}:${l.e}`), ["ws:i", "ws:s", "ws:t", "ws:u"]);
});

test("a view's link hears the hub: events filtered by kind and name, batched per task, and replayed on request", async () => {
  const hub = new ViewEventHub();
  hub.onHookTurn("t1");
  hub.emitCustom("ci.build", { ok: true }, "shell");
  const sent: Array<Record<string, unknown>> = [];
  const link = new CommunityLink({
    pluginId: "p", capabilities: [], commands: {} as never, hasTile: (id) => id === "t1", hasFrame: () => false,
    onReady: () => {}, onLayout: () => {}, onFramesDrawn: () => {}, onError: () => {}, onDisable: () => {},
    services: { events: { subscribe: (l) => hub.subscribe(l), replay: (s, a, v) => hub.replay(s, a, v) } },
  });
  link.attach({ postMessage: (m) => sent.push(m as Record<string, unknown>), onmessage: null });
  const batches = () => sent.filter((m) => m.type === "events");
  link.handle({ type: "ready", v: 1 });
  link.handle({ type: "subscribeEvents", kinds: ["custom"], custom: ["ci.*"], replaySince: 0 });
  const replay = batches();
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.replay, true);
  assert.deepEqual((replay[0]!.events as Array<{ kind: string }>).map((e) => e.kind), ["custom"]);
  assert.equal(hub.emitCustom("deploy.done", null, "shell").delivered, false);
  assert.equal(hub.emitCustom("ci.test", null, { tileId: "t1" }).delivered, true);
  hub.onHookTurn("t1");
  hub.emitCustom("ci.lint", null, "shell");
  await new Promise((r) => setTimeout(r, 0));
  const live = batches().slice(1);
  assert.equal(live.length, 1);
  assert.deepEqual((live[0]!.events as Array<{ name: string }>).map((e) => e.name), ["ci.test", "ci.lint"]);
  assert.equal(hub.emitCustom("ci.y", null, "shell", "someone-else").delivered, false);
  assert.equal(hub.emitCustom("ci.y", null, "shell", "p").delivered, true);
  link.handle({ type: "unsubscribeEvents" });
  assert.equal(hub.emitCustom("ci.x", null, "shell").delivered, false);
});
