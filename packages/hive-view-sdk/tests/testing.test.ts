// The fake host a view's own tests run against (@hivemind/view-sdk/testing): it greets the view as
// its options say, keeps what the view sends that the app would take and says why it would refuse
// the rest, answers requests from the test, and asks the view where a tile is.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";

const structure = {
  type: "structure" as const,
  frames: [{ id: "f1", title: "api", color: "#336699" }],
  tiles: ["t1", "t2"].map((id) => ({ id, frameId: "f1", kind: "shell", name: id })),
};

test("a view is greeted as the options say; what it sends is kept when the app would take it, and refused with the app's reason when not", async () => {
  const host = fakeHost({ capabilities: ["workspace:close"], device: { touch: true, compact: true }, layout: { docked: "t1" }, features: ["participants"] });
  const hm = await host.connect();
  expect(hm.device).toEqual({ touch: true, compact: true });
  expect(hm.hello.layout).toEqual({ docked: "t1" });
  expect(hm.features).toEqual(["participants"]);
  host.send(structure);
  await host.settle();
  hm.commands.closeTile("t2");
  hm.commands.selectTile("t9");
  hm.setSurfaceRects([{ tileId: "t1", x: 0, y: 0, w: 100, h: 80 }]);
  hm.subscribeStatus("t1", () => {});
  hm.subscribeStatus("t9", () => {});
  hm.onParticipants(() => {});
  await host.settle();
  expect(host.commands).toEqual([{ name: "closeTile", args: ["t2"] }]);
  expect(host.rects).toEqual([{ tileId: "t1", x: 0, y: 0, w: 100, h: 80 }]);
  expect([...host.subscribed.status]).toEqual(["t1"]);
  expect(host.subscribed.participants).toBe(true);
  expect(host.refused).toEqual(["selectTile: unknown tile t9", "subscribeStatus: unknown tile t9"]);
});

test("1.17: a view's line slots are kept by a host that draws lines; the client sends none to one that does not", async () => {
  const host = fakeHost({ features: ["lineSlots"] });
  const hm = await host.connect();
  host.send(structure);
  await host.settle();
  hm.setLineRects([{ tileId: "t1", x: 8, y: 40, w: 240, h: 20 }, { tileId: "t9", x: 8, y: 64, w: 240, h: 20 }]);
  await host.settle();
  expect(host.lines).toEqual([{ tileId: "t1", x: 8, y: 40, w: 240, h: 20 }]);
  expect(host.refused).toEqual([]);

  const older = fakeHost({ features: ["surfaces"] });
  const view = await older.connect();
  older.send(structure);
  await older.settle();
  view.setLineRects([{ tileId: "t1", x: 8, y: 40, w: 240, h: 20 }]);
  await older.settle();
  expect([older.lines, older.refused]).toEqual([[], []]);
});

test("a request is answered from the test's answers, and one it gave none for is UNSUPPORTED", async () => {
  const codex = { id: "codex", label: "Codex", default: true, turns: true, resumes: false, sessions: false };
  const host = fakeHost({ answers: { agents: () => ({ agents: [codex] }), history: () => { throw Object.assign(new Error("busy"), { code: "BUSY" }); } } });
  const hm = await host.connect();
  // Settled with a plain await, not `expect(...).rejects`: from Bun 1.3.14 until oven-sh/bun#37189 is
  // fixed, that waits by running the event loop in place, and the loop delivers nothing to a port
  // that is still dispatching a message, as the client's is when a test resumes after an answer.
  const [agents, history, share] = await Promise.allSettled([hm.agents(), hm.history("2026-09-30"), hm.share(new ArrayBuffer(4))]);
  expect(agents).toEqual({ status: "fulfilled", value: [codex] });
  expect(history).toMatchObject({ status: "rejected", reason: { code: "BUSY" } });
  expect(share).toMatchObject({ status: "rejected", reason: { code: "UNSUPPORTED" } });
});

test("the host asks the view where a tile is, and hears its answer", async () => {
  const host = fakeHost();
  const hm = await host.connect();
  hm.onReveal((id) => (id === "t1" ? { x: 1, y: 2, w: 3, h: 4 } : null));
  expect(await host.reveal("t1")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  expect(await host.reveal("t2")).toBeNull();
});

test("a view reads what the person set it to, and hears each change", async () => {
  const host = fakeHost({ settings: { columns: "todo" } });
  const hm = await host.connect();
  expect(hm.settings).toEqual({ columns: "todo" });
  const heard: unknown[] = [];
  hm.on("settings", (s) => heard.push(s));
  host.send({ type: "settings", settings: { columns: "all" } });
  await host.settle();
  expect(heard).toEqual([{ columns: "all" }]);
  expect(hm.settings).toEqual({ columns: "all" });
  // A host before 1.7 sends none: empty, so a view reads each with its default beside it.
  expect((await fakeHost().connect()).settings).toEqual({});
});

test("1.14: a view sees which agent is asleep and since when, wakes it with workspace:spawn, and a prompt to it is refused ASLEEP", async () => {
  const host = fakeHost({ capabilities: ["workspace:spawn", "workspace:prompt"], answers: { prompt: () => ({ outcome: "sent" }) } });
  const hm = await host.connect();
  expect(hm.supports("sleep")).toBe(true);
  const tiles: unknown[] = [];
  hm.on("structure", (s) => tiles.push(...s.tiles));
  host.send({ ...structure, tiles: [{ id: "t1", frameId: "f1", kind: "claude", name: "a", agent: "claude", asleep: { since: 1_760_700_000_000 } }] });
  await host.settle();
  expect(tiles).toEqual([{ id: "t1", frameId: "f1", kind: "claude", name: "a", agent: "claude", asleep: { since: 1_760_700_000_000 } }]);
  const [asleep] = await Promise.allSettled([hm.prompt("t1", "run the tests")]);
  expect(asleep).toMatchObject({ status: "rejected", reason: { code: "ASLEEP" } });
  hm.commands.wakeAgent("t1");
  hm.commands.sleepAgent("t1");
  await host.settle();
  expect(host.commands).toEqual([{ name: "wakeAgent", args: ["t1"] }, { name: "sleepAgent", args: ["t1"] }]);
  host.send({ ...structure, tiles: [{ id: "t1", frameId: "f1", kind: "claude", name: "a", agent: "claude" }] });
  await host.settle();
  expect(await hm.prompt("t1", "run the tests")).toBe("sent");
  expect(host.refused).toEqual([]);
});

test("1.14: waking or putting an agent to sleep needs workspace:spawn", async () => {
  const hm = await fakeHost().connect();
  expect(() => hm.commands.wakeAgent("t1")).toThrow(/workspace:spawn/);
  expect(() => hm.commands.sleepAgent("t1")).toThrow(/workspace:spawn/);
});
