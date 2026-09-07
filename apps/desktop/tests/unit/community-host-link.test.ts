// The host end of a community view's port: validation, permission gating,
// thresholds (malformed / flood / long tasks), version mismatch, reveal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommunityLink, LIMITS, type LinkDeps } from "../../src/renderer/src/workspace/views/community/host-link";

function harness(caps: LinkDeps["capabilities"] = [], tiles = ["t1", "t2"]) {
  const calls: string[] = [];
  const events: string[] = [];
  const sent: unknown[] = [];
  let clock = 0;
  const statusCbs = new Map<string, (s: string, e: unknown) => void>();
  const commands = new Proxy({}, {
    get: (_t, k: string) => {
      if (k === "subscribeTileStatus") return (id: string, cb: (s: string, e: unknown) => void) => { statusCbs.set(id, cb); return () => statusCbs.delete(id); };
      return (...args: unknown[]) => calls.push(`${k}(${args.map((a) => JSON.stringify(a)).join(",")})`);
    },
  }) as LinkDeps["commands"];
  const link = new CommunityLink({
    pluginId: "p", capabilities: caps, commands,
    hasTile: (id) => tiles.includes(id), hasFrame: (id) => id === "f1",
    onReady: () => events.push("ready"),
    onSurfaceRects: (r) => events.push(`rects:${r.map((x) => x.tileId).join(",")}`),
    onLayout: (d) => events.push(`layout:${JSON.stringify(d)}`),
    onFramesDrawn: (n) => events.push(`frames:${n}`),
    onError: (m) => events.push(`error:${m}`),
    onDisable: (why) => events.push(`disable:${why}`),
    now: () => clock,
  });
  link.attach({ postMessage: (m) => sent.push(m), onmessage: null });
  const tick = (ms: number) => { clock += ms; };
  return { link, calls, events, sent, statusCbs, tick };
}

test("ready gates everything; a wrong protocol version disables", () => {
  const h = harness();
  h.link.handle({ type: "command", name: "selectTile", args: ["t1"] });
  assert.deepEqual(h.calls, []);
  assert.equal(h.link.stats.refused, 1);
  h.link.handle({ type: "ready", v: 1 });
  assert.deepEqual(h.events, ["ready"]);
  h.link.handle({ type: "command", name: "selectTile", args: ["t1"] });
  assert.deepEqual(h.calls, ['selectTile("t1")']);
  const h2 = harness();
  h2.link.handle({ type: "ready", v: 2 });
  assert.match(h2.events[0]!, /^disable:protocol version 2/);
  assert.equal(h2.link.stats.disabled !== null, true);
});

test("permissions: a command the manifest did not request is refused, granted ones run", () => {
  const h = harness([]);
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "command", name: "addFrame", args: [] });
  h.link.handle({ type: "command", name: "closeTile", args: ["t1"] });
  assert.deepEqual(h.calls, []);
  assert.equal(h.link.stats.refused, 2);
  const g = harness(["workspace:spawn", "workspace:close"]);
  g.link.handle({ type: "ready", v: 1 });
  g.link.handle({ type: "command", name: "addFrame", args: [] });
  g.link.handle({ type: "command", name: "closeTile", args: ["t1"] });
  g.link.handle({ type: "command", name: "spawnTile", args: ["shell", "f1"] });
  g.link.handle({ type: "command", name: "spawnTile", args: ["planReview", "f1"] });
  g.link.handle({ type: "command", name: "spawnTile", args: ["shell", "nope"] });
  assert.deepEqual(g.calls, ["addFrame()", 'closeTile("t1")', 'spawnTile("shell","f1")']);
  assert.equal(g.link.stats.refused, 2);
});

test("ids are checked against the workspace: unknown tiles never reach a command or a subscription", () => {
  const h = harness();
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "command", name: "focusTile", args: ["ghost"] });
  h.link.handle({ type: "subscribeStatus", tileId: "ghost" });
  h.link.handle({ type: "surfaceRects", rects: [{ tileId: "t1", x: 0, y: 0, w: 1, h: 1 }, { tileId: "ghost", x: 0, y: 0, w: 1, h: 1 }] });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.events, ["ready", "rects:t1"]);
  assert.equal(h.link.stats.refused, 3);
});

test("status: one bus subscription per tile, bucketed and forwarded; dropTile/unsubscribe release it", () => {
  const h = harness();
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "subscribeStatus", tileId: "t1" });
  h.link.handle({ type: "subscribeStatus", tileId: "t1" });
  assert.equal(h.statusCbs.size, 1);
  h.statusCbs.get("t1")!("permission", {});
  assert.deepEqual(h.sent.at(-1), { type: "status", tileId: "t1", status: "blocked" });
  h.link.handle({ type: "unsubscribeStatus", tileId: "t1" });
  assert.equal(h.statusCbs.size, 0);
  h.link.handle({ type: "subscribeStatus", tileId: "t2" });
  h.link.dropTile("t2");
  assert.equal(h.statusCbs.size, 0);
  assert.equal(h.link.stats.statusSubscriptions, 0);
});

test("thresholds: malformed count, message flood, attributed long tasks each disable once", () => {
  const m = harness();
  m.link.handle({ type: "ready", v: 1 });
  for (let i = 0; i < LIMITS.malformed; i++) m.link.handle({ type: "nonsense" });
  assert.equal(m.events.filter((e) => e.startsWith("disable:")).length, 1);
  assert.match(m.events.at(-1)!, /^disable:8 malformed/);
  m.link.handle({ type: "command", name: "selectTile", args: ["t1"] });
  assert.deepEqual(m.calls, []); // dead after disable

  const f = harness();
  f.link.handle({ type: "ready", v: 1 });
  for (let i = 0; i < LIMITS.messagesPerSecond - 1; i++) f.link.handle({ type: "framesDrawn", count: i }); // + ready = the limit
  assert.equal(f.link.stats.disabled, null);
  f.link.handle({ type: "framesDrawn", count: 0 });
  assert.match(f.link.stats.disabled!, /^message flood/);
  // …but the same volume spread over two seconds is fine.
  const ok = harness();
  ok.link.handle({ type: "ready", v: 1 });
  for (let i = 0; i < LIMITS.messagesPerSecond - 1; i++) ok.link.handle({ type: "framesDrawn", count: i });
  ok.tick(1000);
  for (let i = 0; i < 10; i++) ok.link.handle({ type: "framesDrawn", count: i });
  assert.equal(ok.link.stats.disabled, null);

  const l = harness();
  l.link.handle({ type: "ready", v: 1 });
  l.link.noteLongTask(800); l.tick(500); l.link.noteLongTask(600);
  assert.equal(l.link.stats.disabled, null);
  l.tick(500); l.link.noteLongTask(200);
  assert.match(l.link.stats.disabled!, /^runaway: 1600 ms/);
  const w = harness();
  w.link.handle({ type: "ready", v: 1 });
  w.link.noteLongTask(1400); w.tick(LIMITS.windowMs + 1); w.link.noteLongTask(1400);
  assert.equal(w.link.stats.disabled, null); // window slid
});

test("reveal: request/answer by id; an unknown requestId is refused; timeout resolves null", async () => {
  const h = harness();
  h.link.handle({ type: "ready", v: 1 });
  const p = h.link.reveal("t1", 50);
  const req = h.sent.at(-1) as { type: string; requestId: number; tileId: string };
  assert.equal(req.type, "reveal");
  h.link.handle({ type: "revealed", requestId: req.requestId, rect: { x: 1, y: 2, w: 3, h: 4 } });
  assert.deepEqual(await p, { x: 1, y: 2, w: 3, h: 4 });
  h.link.handle({ type: "revealed", requestId: 999, rect: null });
  assert.equal(h.link.stats.refused, 1);
  assert.equal(await h.link.reveal("t1", 10), null);
});

test("layout and framesDrawn and error are forwarded; dispose releases subscriptions", () => {
  const h = harness();
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "layout", data: { a: 1 } });
  h.link.handle({ type: "framesDrawn", count: 7 });
  h.link.handle({ type: "error", message: "oops" });
  h.link.handle({ type: "subscribeStatus", tileId: "t1" });
  assert.deepEqual(h.events.slice(1), ['layout:{"a":1}', "frames:7", "error:oops"]);
  assert.equal(h.link.stats.framesDrawn, 7);
  h.link.dispose();
  assert.equal(h.statusCbs.size, 0);
});
