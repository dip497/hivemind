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

test("a request is answered from the test's answers, and one it gave none for is UNSUPPORTED", async () => {
  const codex = { id: "codex", label: "Codex", default: true, turns: true, resumes: false, sessions: false };
  const host = fakeHost({ answers: { agents: () => ({ agents: [codex] }), history: () => { throw Object.assign(new Error("busy"), { code: "BUSY" }); } } });
  const hm = await host.connect();
  expect(await hm.agents()).toEqual([codex]);
  await expect(hm.history("2026-09-30")).rejects.toMatchObject({ code: "BUSY" });
  await expect(hm.share(new ArrayBuffer(4))).rejects.toMatchObject({ code: "UNSUPPORTED" });
});

test("the host asks the view where a tile is, and hears its answer", async () => {
  const host = fakeHost();
  const hm = await host.connect();
  hm.onReveal((id) => (id === "t1" ? { x: 1, y: 2, w: 3, h: 4 } : null));
  expect(await host.reveal("t1")).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  expect(await host.reveal("t2")).toBeNull();
});
