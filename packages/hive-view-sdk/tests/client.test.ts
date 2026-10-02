// The client against a scripted host over a real MessageChannel.
import { describe, expect, test } from "bun:test";
import { connect } from "../src/client.js";
import { PORT_HANDSHAKE, type PluginMessage } from "../src/protocol.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function scriptedHost(capabilities: string[] = [], features?: string[], hello: Record<string, unknown> = {}) {
  const target = new EventTarget() as unknown as Window;
  const ch = new MessageChannel();
  const inbox: PluginMessage[] = [];
  ch.port1.onmessage = (e) => {
    inbox.push(e.data as PluginMessage);
    if ((e.data as PluginMessage).type === "ready") {
      ch.port1.postMessage({ type: "hello", v: 1, pluginId: "p", capabilities, theme: { colors: { bg: "#000000" } }, layout: { saved: 1 }, viewport: { w: 800, h: 600 }, visible: true, ...(features ? { features } : {}), ...hello });
    }
  };
  ch.port1.start();
  const pending = connect({ target, timeoutMs: 2000 });
  target.dispatchEvent(new MessageEvent("message", { data: { type: PORT_HANDSHAKE }, ports: [ch.port2] }));
  const client = await pending;
  const send = (m: unknown) => ch.port1.postMessage(m);
  return { client, inbox, send };
}

describe("view-sdk client", () => {
  test("handshake → ready → hello, then events + status subscription refcount", async () => {
    const { client, inbox, send } = await scriptedHost();
    expect(inbox[0]).toEqual({ type: "ready", v: 1 });
    expect(client.hello.layout).toEqual({ saved: 1 });
    expect(client.viewport).toEqual({ w: 800, h: 600 });

    const seen: unknown[] = [];
    client.on("structure", (m) => seen.push(m.tiles.length));
    send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
    await tick();
    expect(seen).toEqual([1]);

    const statuses: string[] = [];
    const off1 = client.subscribeStatus("t1", (s) => statuses.push(`a:${s}`));
    const off2 = client.subscribeStatus("t1", (s) => statuses.push(`b:${s}`));
    await tick();
    expect(inbox.filter((m) => m.type === "subscribeStatus")).toHaveLength(1);
    send({ type: "status", tileId: "t1", status: "working" });
    await tick();
    expect(statuses).toEqual(["a:working", "b:working"]);
    off1();
    await tick();
    expect(inbox.filter((m) => m.type === "unsubscribeStatus")).toHaveLength(0);
    off2();
    await tick();
    expect(inbox.filter((m) => m.type === "unsubscribeStatus")).toHaveLength(1);
  });

  test("commands are gated by granted permissions; surface rects are deduplicated", async () => {
    const { client, inbox, send } = await scriptedHost([]);
    send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
    await tick();
    client.commands.selectTile("t1");
    expect(() => client.commands.addFrame()).toThrow(/workspace:spawn/);
    client.setSurfaceRects([{ tileId: "t1", x: 1.2, y: 2.7, w: 10, h: 10 }]);
    client.setSurfaceRects([{ tileId: "t1", x: 1.4, y: 2.6, w: 10, h: 10 }]); // same after rounding
    await tick();
    expect(inbox.filter((m) => m.type === "command")).toEqual([{ type: "command", name: "selectTile", args: ["t1"] }]);
    expect(inbox.filter((m) => m.type === "surfaceRects")).toEqual([{ type: "surfaceRects", rects: [{ tileId: "t1", x: 1, y: 3, w: 10, h: 10 }] }]);
  });

  test("undock from the host drops the rect on the client and fires the event", async () => {
    const { client, inbox, send } = await scriptedHost();
    send({ type: "structure", frames: [], tiles: ["t1", "t2"].map((id) => ({ id, frameId: null, kind: "shell", name: id })) });
    await tick();
    client.setSurfaceRects([{ tileId: "t1", x: 0, y: 0, w: 10, h: 10, chrome: "none" }, { tileId: "t2", x: 20, y: 0, w: 10, h: 10 }]);
    const seen: string[] = [];
    client.on("undock", ({ tileId }) => seen.push(tileId));
    send({ type: "undock", tileId: "t1" });
    await tick();
    expect(seen).toEqual(["t1"]);
    // Re-sending the remaining rect is a no-op (the client already forgot t1) …
    client.setSurfaceRects([{ tileId: "t2", x: 20, y: 0, w: 10, h: 10 }]);
    await tick();
    expect(inbox.filter((m) => m.type === "surfaceRects")).toHaveLength(1);
    // … and the first send carried the chrome flag through.
    expect((inbox.find((m) => m.type === "surfaceRects") as { rects: unknown[] }).rects[0]).toEqual({ tileId: "t1", x: 0, y: 0, w: 10, h: 10, chrome: "none" });
  });

  test("reveal round-trips through the handler; malformed host messages are dropped", async () => {
    const { client, inbox, send } = await scriptedHost();
    client.onReveal((id) => (id === "t1" ? { x: 5, y: 6, w: 7, h: 8 } : null));
    send({ type: "reveal", requestId: 9, tileId: "t1" });
    send({ type: "status", tileId: "t1", status: "purple" });
    send({ type: "selection", tileId: "t1" });
    await tick(); await tick();
    expect(inbox.filter((m) => m.type === "revealed")).toEqual([{ type: "revealed", requestId: 9, rect: { x: 5, y: 6, w: 7, h: 8 } }]);
  });

  test("a host without features gets no 1.3 message, and the promise methods reject UNSUPPORTED", async () => {
    const { client, inbox } = await scriptedHost();
    expect(client.features).toEqual([]);
    client.onEvents(["turn"], () => {});
    client.onCustom("ci.*", () => {});
    client.activity("t1", () => {});
    client.onPresence(() => {});
    await expect(client.history("2026-09-23")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.share(new ArrayBuffer(4))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await tick();
    expect(inbox.map((m) => m.type)).toEqual(["ready"]);
  });

  test("status carries since and exact when the host sends them", async () => {
    const { client, send } = await scriptedHost([], ["since"]);
    const seen: unknown[] = [];
    client.subscribeStatus("t1", (s, info) => seen.push([s, info]));
    send({ type: "status", tileId: "t1", status: "blocked", since: 100, exact: false });
    send({ type: "status", tileId: "t1", status: "idle" });
    await tick();
    expect(seen).toEqual([["blocked", { since: 100, exact: false }], ["idle", undefined]]);
  });

  test("event listeners merge into one subscription; each listener sees an event once", async () => {
    const { client, inbox, send } = await scriptedHost([], ["events"]);
    const a: string[] = [];
    const b: string[] = [];
    const offA = client.onEvents(["turn"], (e) => a.push(`${e.kind}${e.seq}`));
    const offB = client.onCustom(["ci.*"], (e) => b.push(e.name), { replaySince: 0 });
    await tick();
    const subs = inbox.filter((m) => m.type === "subscribeEvents");
    expect(subs).toEqual([{ type: "subscribeEvents", kinds: ["custom", "turn"], custom: ["ci.*"], replaySince: 0 }]);
    const turn = { kind: "turn", seq: 1, at: 1, tileId: "t1" };
    const ci = { kind: "custom", seq: 2, at: 2, id: "e", name: "ci.build", data: null, from: "shell" };
    const other = { kind: "custom", seq: 3, at: 3, id: "f", name: "deploy.done", data: null, from: "shell" };
    send({ type: "events", events: [turn, ci, other] });
    send({ type: "events", events: [turn, ci], replay: true });
    await tick();
    expect(a).toEqual(["turn1"]);
    expect(b).toEqual(["ci.build"]);
    offA();
    await tick();
    expect(inbox.filter((m) => m.type === "subscribeEvents").at(-1)).toEqual({ type: "subscribeEvents", kinds: ["custom"], custom: ["ci.*"] });
    offB();
    await tick();
    expect(inbox.at(-1)).toEqual({ type: "unsubscribeEvents" });
  });

  test("activity listeners coalesce into one watched set per task", async () => {
    const { client, inbox, send } = await scriptedHost([], ["activity"]);
    const levels: number[] = [];
    const off1 = client.activity("t1", (l) => levels.push(l));
    const off2 = client.activity("t2", () => {});
    client.activity("t1", () => {});
    await tick();
    expect(inbox.filter((m) => m.type === "watchActivity")).toEqual([{ type: "watchActivity", tileIds: ["t1", "t2"] }]);
    send({ type: "activity", levels: { t1: 2 } });
    await tick();
    expect(levels).toEqual([2]);
    off1(); off2();
    await tick();
    expect(inbox.filter((m) => m.type === "watchActivity").at(-1)).toEqual({ type: "watchActivity", tileIds: ["t1"] });
  });

  test("presence subscribes once and replays the latest state to a late listener", async () => {
    const { client, inbox, send } = await scriptedHost([], ["presence"]);
    const first: string[] = [];
    const off = client.onPresence((p) => first.push(p.state));
    send({ type: "presence", presence: { state: "away", since: 1, focused: false } });
    await tick();
    const late: string[] = [];
    const off2 = client.onPresence((p) => late.push(p.state));
    expect(first).toEqual(["away"]);
    expect(late).toEqual(["away"]);
    off(); off2();
    await tick();
    expect(inbox.filter((m) => m.type === "subscribePresence")).toHaveLength(1);
    expect(inbox.filter((m) => m.type === "unsubscribePresence")).toHaveLength(1);
  });

  test("history and share round-trip through request/response", async () => {
    const { client, inbox, send } = await scriptedHost([], ["history", "share"]);
    const h = client.history("2026-09-23");
    const png = new ArrayBuffer(16);
    const s = client.share(png, { suggestedName: "card" });
    await tick();
    const reqs = inbox.filter((m) => m.type === "request") as Array<{ requestId: number; name: string }>;
    expect(reqs.map((r) => r.name)).toEqual(["history", "share"]);
    expect(png.byteLength).toBe(0); // transferred, not copied
    send({ type: "response", requestId: reqs[0]!.requestId, ok: true, result: { day: "2026-09-23" } });
    send({ type: "response", requestId: reqs[1]!.requestId, ok: false, error: { code: "DECLINED", message: "no" } });
    // Settled with a plain await, not `expect(s).rejects`: from Bun 1.3.14 until oven-sh/bun#37189 is
    // fixed, that waits by running the event loop in place, and the loop delivers nothing to a port
    // that is still dispatching a message. After `await h` this test runs inside the client port's
    // dispatch of h's answer, so s's answer would never arrive.
    const [history, share] = await Promise.allSettled([h, s]);
    expect(history).toEqual({ status: "fulfilled", value: { day: "2026-09-23" } } as never);
    expect(share).toMatchObject({ status: "rejected", reason: { code: "DECLINED" } });
  });

  test("1.4: agent status rides on status; sessions and prompt check permissions and features locally", async () => {
    const { client, inbox, send } = await scriptedHost(["workspace:spawn"], ["agentStatus", "agents", "sessions", "prompt"]);
    const seen: unknown[] = [];
    client.subscribeStatus("t1", (s, info) => seen.push([s, info?.agent?.state]));
    send({ type: "status", tileId: "t1", status: "working", agent: { state: "working", subagents: 1, background: 0, compacting: false } });
    await tick();
    expect(seen).toEqual([["working", "working"]]);
    expect(() => client.sessions("claude", "f1")).toThrow(/workspace:sessions/);
    expect(() => client.prompt("t1", "go")).toThrow(/workspace:prompt/);
    expect(() => client.commands.spawnAgent("claude", "f1", { prompt: "go" })).toThrow(/workspace:prompt/);
    expect(() => client.commands.spawnAgent("claude", "f1", { resume: "s1" })).toThrow(/workspace:sessions/);
    const agents = client.agents();
    await tick();
    const req = inbox.find((m) => m.type === "request") as { requestId: number; name: string };
    expect(req.name).toBe("agents");
    send({ type: "response", requestId: req.requestId, ok: true, result: { agents: [{ id: "claude", label: "Claude", default: true, turns: true, resumes: true, sessions: true }] } });
    expect((await agents).map((a) => a.id)).toEqual(["claude"]);
    const p = await scriptedHost(["workspace:prompt"], ["prompt"]);
    await expect(p.client.prompt("t1", "bad\u001b")).rejects.toThrow(/control/);
  });

  test("1.5: a rect goes to the host once a structure names its tile, and leaves when none does", async () => {
    const { client, inbox, send } = await scriptedHost();
    const told = () => inbox.filter((m) => m.type === "surfaceRects").map((m) => (m as { rects: { tileId: string }[] }).rects.map((r) => r.tileId));
    // Docked as a saved layout says: one tile is not heard of yet, the other is gone for good.
    client.setSurfaceRects([{ tileId: "t1", x: 0, y: 0, w: 10, h: 10 }, { tileId: "gone", x: 20, y: 0, w: 10, h: 10 }]);
    await tick();
    expect(told()).toEqual([]);
    send({ type: "structure", frames: [], tiles: [{ id: "t1", frameId: null, kind: "shell", name: "sh" }] });
    await tick();
    expect(told()).toEqual([["t1"]]);
    // t1 closes: the host hears it is shown no more, without the view asking again.
    send({ type: "structure", frames: [], tiles: [] });
    await tick();
    expect(told()).toEqual([["t1"], []]);
  });

  test("1.5: participants subscribe once and replay the latest to a late listener; a host without them is never asked", async () => {
    const { client, inbox, send } = await scriptedHost([], ["participants"]);
    const priya = { id: "c1", person: "p1", name: "Priya", color: "#ec4899", cursor: { tileId: "t1" }, selection: ["t1"] };
    const first: string[][] = [];
    const off = client.onParticipants((ps) => first.push(ps.map((p) => p.name)));
    send({ type: "participants", participants: [priya] });
    await tick();
    const late: string[][] = [];
    const off2 = client.onParticipants((ps) => late.push(ps.map((p) => p.name)));
    expect(first).toEqual([["Priya"]]);
    expect(late).toEqual([["Priya"]]);
    off(); off2();
    await tick();
    expect(inbox.filter((m) => m.type === "subscribeParticipants")).toHaveLength(1);
    expect(inbox.filter((m) => m.type === "unsubscribeParticipants")).toHaveLength(1);
    const older = await scriptedHost();
    older.client.onParticipants(() => {});
    await tick();
    expect(older.inbox.map((m) => m.type)).toEqual(["ready"]);
  });

  test("1.5: the device is the host's, and a desktop's from a host that predates it", async () => {
    const phone = await scriptedHost([], [], { device: { touch: true, compact: true } });
    expect(phone.client.device).toEqual({ touch: true, compact: true });
    const older = await scriptedHost();
    expect(older.client.device).toEqual({ touch: false, compact: false });
  });
});
