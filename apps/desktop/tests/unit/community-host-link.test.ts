// The host end of a community view's port: validation, permission gating,
// thresholds (malformed / flood / long tasks), version mismatch, reveal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommunityLink, LIMITS, PROMPT_DECLINES_MAX, SHARE_DECLINES_MAX, type LinkDeps, type LinkServices } from "../../src/renderer/src/workspace/views/community/host-link";
import { ViewEventHub } from "../../src/renderer/src/workspace/view-events";
import type { ActivityLevel, ShareOutcome, ViewParticipant, ViewPresence } from "@hivemind/view-sdk/protocol";

function harness(caps: LinkDeps["capabilities"] = [], tiles = ["t1", "t2"], services?: LinkServices) {
  const calls: string[] = [];
  const events: string[] = [];
  const sent: unknown[] = [];
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
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
    services,
    schedule: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
  });
  link.attach({ postMessage: (m) => sent.push(m), onmessage: null });
  const tick = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
  };
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

test("1.2 commands: spawnAgent needs spawn, rename/openFolder need edit, ids are checked", () => {
  const h = harness(["workspace:spawn"]);
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "command", name: "spawnAgent", args: ["codex", "f1", { name: "w" }] });
  h.link.handle({ type: "command", name: "spawnAgent", args: [null, "nope"] });
  h.link.handle({ type: "command", name: "renameTile", args: ["t1", "x"] });
  assert.deepEqual(h.calls, ['spawnAgent("codex","f1",{"name":"w"})']);
  assert.equal(h.link.stats.refused, 2);
  const e = harness(["workspace:edit"]);
  e.link.handle({ type: "ready", v: 1 });
  e.link.handle({ type: "command", name: "renameTile", args: ["t1", "x"] });
  e.link.handle({ type: "command", name: "renameTile", args: ["ghost", "x"] });
  e.link.handle({ type: "command", name: "openFolder", args: ["f1"] });
  e.link.handle({ type: "command", name: "openFolder", args: ["nope"] });
  assert.deepEqual(e.calls, ['renameTile("t1","x")', 'openFolder("f1")']);
  assert.equal(e.link.stats.refused, 2);
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

// ── protocol 1.3 ────────────────────────────────────────────────────────────

const flush = () => new Promise((r) => setTimeout(r, 0));
const ofType = (sent: unknown[], type: string) => sent.filter((m) => (m as { type: string }).type === type) as Array<Record<string, unknown>>;

function fakeActivity() {
  const levels = new Map<string, ActivityLevel>();
  const subs = new Set<(c: Record<string, ActivityLevel>) => void>();
  const watched = new Map<object, string[]>();
  return {
    service: {
      level: (id: string) => levels.get(id) ?? 0,
      subscribe: (cb: (c: Record<string, ActivityLevel>) => void) => { subs.add(cb); return () => subs.delete(cb); },
      watch: (owner: object, ids: string[]) => { watched.set(owner, ids); },
    },
    set(id: string, l: ActivityLevel) { levels.set(id, l); for (const cb of subs) cb({ [id]: l }); },
    watched,
  };
}

test("1.3: hello features list only what is wired; status carries since", () => {
  const bare = harness();
  assert.deepEqual(bare.link.features, []);
  const h = harness([], ["t1"], { sinceOf: (id) => (id === "t1" ? { since: 42, exact: false } : undefined), history: async () => ({}) as never });
  assert.deepEqual(h.link.features, ["since", "history"]);
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "subscribeStatus", tileId: "t1" });
  h.statusCbs.get("t1")!("question", {});
  assert.deepEqual(h.sent.at(-1), { type: "status", tileId: "t1", status: "blocked", since: 42, exact: false });
});

test("1.3: a feature the host did not wire is a refusal, like an unknown message", () => {
  const h = harness();
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "subscribeEvents", kinds: ["turn"] });
  h.link.handle({ type: "watchActivity", tileIds: ["t1"] });
  h.link.handle({ type: "subscribePresence" });
  assert.equal(h.link.stats.refused, 3);
});

test("1.3: events are filtered by kind and name, batched per task, and replayed on request", async () => {
  const hub = new ViewEventHub();
  hub.onHookTurn("t1");
  hub.emitCustom("ci.build", { ok: true }, "shell");
  const h = harness([], ["t1"], { events: { subscribe: (l) => hub.subscribe(l), replay: (s, a, v) => hub.replay(s, a, v) } });
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "subscribeEvents", kinds: ["custom"], custom: ["ci.*"], replaySince: 0 });
  const replay = ofType(h.sent, "events");
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.replay, true);
  assert.deepEqual((replay[0]!.events as Array<{ kind: string }>).map((e) => e.kind), ["custom"]);
  assert.equal(hub.emitCustom("deploy.done", null, "shell").delivered, false);
  assert.equal(hub.emitCustom("ci.test", null, { tileId: "t1" }).delivered, true);
  hub.onHookTurn("t1");
  hub.emitCustom("ci.lint", null, "shell");
  await flush();
  const live = ofType(h.sent, "events").slice(1);
  assert.equal(live.length, 1);
  assert.deepEqual((live[0]!.events as Array<{ name: string }>).map((e) => e.name), ["ci.test", "ci.lint"]);
  assert.equal(hub.emitCustom("ci.y", null, "shell", "someone-else").delivered, false);
  assert.equal(hub.emitCustom("ci.y", null, "shell", "p").delivered, true);
  h.link.handle({ type: "unsubscribeEvents" });
  assert.equal(hub.emitCustom("ci.x", null, "shell").delivered, false);
});

test("1.3: activity is at most one message per 250 ms, only watched tiles, nothing while hidden, a snapshot on return", () => {
  const a = fakeActivity();
  const h = harness([], ["t1", "t2"], { activity: a.service });
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "watchActivity", tileIds: ["t1", "ghost"] });
  assert.equal(h.link.stats.refused, 1);
  h.tick(0);
  assert.deepEqual(ofType(h.sent, "activity").map((m) => m.levels), [{ t1: 0 }]);
  for (let i = 0; i < 100; i++) { a.set("t1", ((i % 3) + 1) as ActivityLevel); a.set("t2", 3); h.tick(10); }
  const sent = ofType(h.sent, "activity");
  assert.ok(sent.length <= 1 + Math.ceil(1000 / 250), `sent ${sent.length} in 1 s`);
  assert.ok(sent.every((m) => !("t2" in (m.levels as object))));
  const before = sent.length;
  h.link.setVisible(false);
  for (let i = 0; i < 20; i++) { a.set("t1", 3); h.tick(100); }
  assert.equal(ofType(h.sent, "activity").length, before);
  h.link.setVisible(true);
  h.tick(250);
  assert.deepEqual(ofType(h.sent, "activity").at(-1)!.levels, { t1: 3 });
  h.link.dropTile("t1");
  assert.deepEqual(a.watched.get(h.link), []);
});

test("1.3: presence replays the current state and stops on unsubscribe", () => {
  const cbs = new Set<(p: ViewPresence) => void>();
  const cur: ViewPresence = { state: "active", since: 1, focused: true };
  const h = harness([], ["t1"], { presence: { subscribe: (cb) => { cbs.add(cb); cb(cur); return () => cbs.delete(cb); } } });
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "subscribePresence" });
  h.link.handle({ type: "subscribePresence" });
  assert.equal(cbs.size, 1);
  assert.deepEqual(ofType(h.sent, "presence").map((m) => m.presence), [cur]);
  h.link.handle({ type: "unsubscribePresence" });
  assert.equal(cbs.size, 0);
});

test("1.3: history allows one request at a time", async () => {
  let release!: () => void;
  const h = harness([], ["t1"], { history: (day) => new Promise((r) => { release = () => r({ day } as never); }) });
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "request", requestId: 1, name: "history", args: [{ day: "2026-09-23" }] });
  h.link.handle({ type: "request", requestId: 2, name: "history", args: [{ day: "2026-09-22" }] });
  assert.deepEqual(ofType(h.sent, "response").map((m) => [m.requestId, m.ok]), [[2, false]]);
  release();
  await flush();
  assert.deepEqual(ofType(h.sent, "response").at(-1), { type: "response", requestId: 1, ok: true, result: { day: "2026-09-23" } });
});

test("1.3: share — one pending, never while hidden, and declined for the session after three cancels", async () => {
  let answer!: (o: ShareOutcome) => void;
  let shown = 0;
  const h = harness([], ["t1"], { share: () => { shown++; return new Promise((r) => { answer = r; }); } });
  h.link.handle({ type: "ready", v: 1 });
  const ask = (id: number) => h.link.handle({ type: "request", requestId: id, name: "share", args: [{ png: new ArrayBuffer(8) }] });
  ask(1); ask(2);
  assert.deepEqual(ofType(h.sent, "response").map((m) => (m.error as { code: string }).code), ["BUSY"]);
  answer("copied");
  await flush();
  assert.deepEqual(ofType(h.sent, "response").at(-1)!.result, { outcome: "copied" });
  h.link.setVisible(false);
  ask(3);
  assert.equal((ofType(h.sent, "response").at(-1)!.error as { code: string }).code, "BUSY");
  h.link.setVisible(true);
  for (let i = 0; i < SHARE_DECLINES_MAX; i++) { ask(10 + i); answer("cancelled"); await flush(); }
  const before = shown;
  ask(20);
  assert.equal(shown, before);
  assert.equal((ofType(h.sent, "response").at(-1)!.error as { code: string }).code, "DECLINED");
});


const settle = () => new Promise((r) => setTimeout(r, 0));
const responses = (sent: unknown[]) => sent.filter((m) => (m as { type: string }).type === "response") as Array<{ requestId: number; ok: boolean; result?: unknown; error?: { code: string } }>;

test("1.4: features; a status carries the agent's own, and a change in it alone is sent", () => {
  let push: (s: unknown) => void = () => {};
  const h = harness([], ["t1"], { agentStatus: (_id, cb) => { push = cb as never; cb({ state: "working", subagents: 0, background: 0, compacting: false, source: "hooks" }); return () => {}; } });
  h.link.handle({ type: "ready", v: 1 });
  assert.deepEqual(h.link.features, ["agentStatus"]);
  h.link.handle({ type: "subscribeStatus", tileId: "t1" });
  h.statusCbs.get("t1")!("working", {});
  push({ state: "waiting", waitingFor: "permission", subagents: 0, background: 0, compacting: false, source: "hooks" });
  push({ state: "waiting", waitingFor: "permission", subagents: 0, background: 0, compacting: false, source: "hooks" });
  const statuses = h.sent.filter((m) => (m as { type: string }).type === "status") as Array<{ status: string; agent: { state: string } }>;
  assert.deepEqual(statuses.map((m) => `${m.status}/${m.agent.state}`), ["working/working", "working/waiting"]);
});

test("1.4: agents need no permission; sessions need workspace:sessions and a known frame", async () => {
  const services: LinkServices = {
    agents: () => [{ id: "claude", label: "Claude", default: true, turns: true, resumes: true, sessions: true }],
    sessions: async (agent, frameId) => (agent === "claude" && frameId === "f1" ? [{ id: "s1", updated: 1, prompt: "fix it" }] : Promise.reject(Object.assign(new Error("no"), { code: "UNSUPPORTED" }))),
  };
  const h = harness([], ["t1"], services);
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "request", requestId: 1, name: "agents", args: [{}] });
  h.link.handle({ type: "request", requestId: 2, name: "sessions", args: [{ agent: "claude", frameId: "f1" }] });
  await settle();
  assert.deepEqual(responses(h.sent).map((r) => [r.requestId, r.ok, r.error?.code]), [[2, false, "DECLINED"], [1, true, undefined]]);
  const g = harness(["workspace:sessions"], ["t1"], services);
  g.link.handle({ type: "ready", v: 1 });
  g.link.handle({ type: "request", requestId: 1, name: "sessions", args: [{ agent: "claude", frameId: "f1" }] });
  g.link.handle({ type: "request", requestId: 2, name: "sessions", args: [{ agent: "claude", frameId: "nope" }] });
  g.link.handle({ type: "request", requestId: 3, name: "sessions", args: [{ agent: "codex", frameId: "f1" }] });
  await settle();
  const r = responses(g.sent);
  assert.deepEqual(r.map((x) => [x.requestId, x.ok, x.error?.code]).sort(), [[1, true, undefined], [2, false, "BAD_REQUEST"], [3, false, "UNSUPPORTED"]]);
  assert.deepEqual(r.find((x) => x.requestId === 1)!.result, { sessions: [{ id: "s1", updated: 1, prompt: "fix it" }] });
});

test("1.4: a prompt is sent only after the user confirms; one at a time; three cancels decline the rest", async () => {
  const answers: boolean[] = [];
  const asked: string[] = [];
  const typed: string[] = [];
  const services: LinkServices = {
    confirmPrompt: async (req) => { asked.push(req.text); return answers.shift() ?? false; },
    sendPrompt: async (tileId, text) => { typed.push(`${tileId}:${text}`); },
  };
  const none = harness([], ["t1"], services);
  none.link.handle({ type: "ready", v: 1 });
  none.link.handle({ type: "request", requestId: 1, name: "prompt", args: [{ tileId: "t1", text: "go" }] });
  assert.equal(responses(none.sent)[0]!.error!.code, "DECLINED");
  const h = harness(["workspace:prompt"], ["t1"], services);
  h.link.handle({ type: "ready", v: 1 });
  assert.ok(h.link.features.includes("prompt"));
  answers.push(true);
  h.link.handle({ type: "request", requestId: 1, name: "prompt", args: [{ tileId: "t1", text: "run the tests" }] });
  h.link.handle({ type: "request", requestId: 2, name: "prompt", args: [{ tileId: "t1", text: "again" }] });
  await settle();
  assert.deepEqual(responses(h.sent).map((r) => [r.requestId, r.ok ? (r.result as { outcome: string }).outcome : r.error!.code]), [[2, "BUSY"], [1, "sent"]]);
  assert.deepEqual(typed, ["t1:run the tests"]);
  for (let i = 0; i < PROMPT_DECLINES_MAX; i++) {
    h.link.handle({ type: "request", requestId: 10 + i, name: "prompt", args: [{ tileId: "t1", text: `no ${i}` }] });
    await settle();
  }
  h.link.handle({ type: "request", requestId: 20, name: "prompt", args: [{ tileId: "t1", text: "once more" }] });
  await settle();
  assert.equal(responses(h.sent).at(-1)!.error!.code, "DECLINED");
  assert.equal(asked.length, 1 + PROMPT_DECLINES_MAX, "the declined one never reached the user");
  // A prompt that carries keystrokes never gets that far.
  h.link.handle({ type: "request", requestId: 30, name: "prompt", args: [{ tileId: "t1", text: "ok\u001b[2Jrm" }] });
  assert.ok(h.link.stats.refused > 0);
});

test("1.4: spawnAgent with a prompt needs workspace:prompt and a confirm; resume needs workspace:sessions", async () => {
  const answers = [false, true];
  const services: LinkServices = { confirmPrompt: async () => answers.shift() ?? false, sendPrompt: async () => {} };
  const spawn = harness(["workspace:spawn"], ["t1"], services);
  spawn.link.handle({ type: "ready", v: 1 });
  spawn.link.handle({ type: "command", name: "spawnAgent", args: ["claude", "f1", { prompt: "go" }] });
  spawn.link.handle({ type: "command", name: "spawnAgent", args: ["claude", "f1", { resume: "s1" }] });
  assert.deepEqual(spawn.calls, []);
  assert.equal(spawn.link.stats.refused, 2);
  const h = harness(["workspace:spawn", "workspace:prompt", "workspace:sessions"], ["t1"], services);
  h.link.handle({ type: "ready", v: 1 });
  h.link.handle({ type: "command", name: "spawnAgent", args: ["claude", "f1", { prompt: "cancelled one" }] });
  await settle();
  h.link.handle({ type: "command", name: "spawnAgent", args: ["claude", "f1", { prompt: "sent one" }] });
  await settle();
  h.link.handle({ type: "command", name: "spawnAgent", args: ["claude", "f1", { resume: "s1" }] });
  assert.deepEqual(h.calls, ['spawnAgent("claude","f1",{"prompt":"sent one"})', 'spawnAgent("claude","f1",{"resume":"s1"})']);
});

test("1.5: participants: those here at once, then as they change, on the view's own tiles and frames only, told again as those change, and nothing once unsubscribed", () => {
  let tell: (people: ViewParticipant[]) => void = () => {};
  let subscribed = 0;
  const priya = (more: Partial<ViewParticipant> = {}): ViewParticipant => ({ id: "c1", person: "p1", name: "Priya", color: "#ec4899", cursor: { tileId: "t1" }, selection: ["t1", "f1", "note-1"], ...more });
  const tiles = ["t1", "t2"];
  const h = harness([], tiles, { participants: { subscribe: (cb) => { subscribed++; tell = cb; cb([priya()]); return () => { subscribed--; tell = () => {}; }; } } });
  h.link.handle({ type: "ready", v: 1 });
  assert.ok(h.link.features.includes("participants"));
  h.link.handle({ type: "subscribeParticipants" });
  h.link.handle({ type: "subscribeParticipants" });
  assert.equal(subscribed, 1);
  const told = () => h.sent.filter((m) => (m as { type: string }).type === "participants").map((m) => (m as { participants: ViewParticipant[] }).participants);
  assert.deepEqual(told(), [[priya({ selection: ["t1", "f1"] })]]);
  // The same again (a pointer moving within its tile): nothing new to tell.
  tell([priya()]);
  assert.equal(told().length, 1);
  // Over a board object the view does not have: pointing at nothing it knows.
  tell([priya({ cursor: { tileId: "note-1" } })]);
  assert.deepEqual(told().at(-1), [priya({ cursor: null, selection: ["t1", "f1"] })]);
  // t1 closes: once the view hears so, what she selected is told again without it.
  tiles.splice(0, 1);
  h.link.send({ type: "structure", frames: [], tiles: [{ id: "t2", frameId: null, kind: "shell", name: "t2" }] });
  assert.deepEqual(told().at(-1), [priya({ cursor: null, selection: ["f1"] })]);
  h.link.handle({ type: "unsubscribeParticipants" });
  assert.equal(subscribed, 0);
  tell([]);
  assert.equal(told().length, 3);
  assert.equal(h.link.stats.refused, 0);
});

test("1.5: a rect for a tile the view was told of and that has closed since is dropped without a refusal; one for a tile never told of is refused", () => {
  const tiles = ["t1", "t2"];
  const h = harness([], tiles);
  const rect = (tileId: string) => ({ tileId, x: 0, y: 0, w: 10, h: 10 });
  h.link.handle({ type: "ready", v: 1 });
  h.link.send({ type: "structure", frames: [], tiles: tiles.map((id) => ({ id, frameId: null, kind: "shell", name: id })) });
  tiles.splice(0, 1);
  h.link.handle({ type: "surfaceRects", rects: [rect("t1"), rect("t2")] });
  assert.equal(h.link.stats.refused, 0);
  assert.equal(h.events.at(-1), "rects:t2");
  h.link.handle({ type: "surfaceRects", rects: [rect("t2"), rect("t9")] });
  assert.equal(h.link.stats.refused, 1);
  assert.equal(h.events.at(-1), "rects:t2");
});
