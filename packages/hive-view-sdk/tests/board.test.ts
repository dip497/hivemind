// The board feature (protocol 1.20): a view with `workspace:board` reads, pictures and follows the
// board; with `workspace:draw` it draws, changes, erases and takes back its own writes. The client
// refuses a call without its permission before anything is sent, and the host refuses one sent anyway.
import { expect, test } from "bun:test";
import { fakeHost } from "../src/testing.js";
import type { ViewBoardChange } from "../src/protocol.js";

const reading = { frames: [], tiles: [], drawings: [], objects: [] };
const drawn = { drawing: "d1", objects: ["s1"], boxes: { a: "s1" }, box: { x: 0, y: 0, w: 10, h: 10 }, overlaps: [], problems: [] };

test("a view with both permissions reads, pictures, draws, changes, erases and undoes, each asked as it wrote it", async () => {
  const asked: Array<[string, unknown]> = [];
  const host = fakeHost({
    features: ["board"], capabilities: ["workspace:board", "workspace:draw"],
    answers: {
      boardRead: (a) => { asked.push(["boardRead", a]); return reading; },
      boardPicture: (a) => { asked.push(["boardPicture", a]); return { width: 1, height: 1, svg: "<svg/>" }; },
      boardDraw: (a) => { asked.push(["boardDraw", a]); return drawn; },
      boardChange: (a) => { asked.push(["boardChange", a]); return { changed: ["s1"], locked: [] }; },
      boardErase: (a) => { asked.push(["boardErase", a]); return { erased: ["s1"] }; },
      boardUndo: (a) => { asked.push(["boardUndo", a]); return { undone: true }; },
    },
  });
  const hm = await host.connect();
  expect(hm.supports("board")).toBe(true);
  expect(await hm.board.read({ page: "p1" })).toEqual(reading);
  expect((await hm.board.picture()).svg).toBe("<svg/>");
  expect((await hm.board.draw({ boxes: [{ id: "a", text: "Cart" }], page: null })).drawing).toBe("d1");
  expect((await hm.board.change({ ids: ["s1"], color: "blue", stack: "front" })).changed).toEqual(["s1"]);
  expect(await hm.board.erase({ drawing: "d1" })).toEqual({ erased: ["s1"] });
  expect(await hm.board.undo()).toEqual({ undone: true });
  expect(asked).toEqual([
    ["boardRead", { page: "p1" }],
    ["boardPicture", {}],
    ["boardDraw", { boxes: [{ id: "a", text: "Cart" }], page: null }],
    ["boardChange", { ids: ["s1"], color: "blue", stack: "front" }],
    ["boardErase", { drawing: "d1" }],
    ["boardUndo", {}],
  ]);
  expect(host.refused).toEqual([]);
});

test("reading does not let a view draw, nor drawing read: the client throws and the host refuses", async () => {
  const reader = fakeHost({ features: ["board"], capabilities: ["workspace:board"], answers: { boardDraw: () => drawn } });
  const hm = await reader.connect();
  expect(() => hm.board.draw({ shapes: [] })).toThrow('needs permission "workspace:draw"');
  expect(() => hm.board.undo()).toThrow('needs permission "workspace:draw"');
  (hm as unknown as { send(m: unknown): void }).send({ type: "request", requestId: 90, name: "boardDraw", args: [{ shapes: [] }] });
  await reader.settle();
  expect(reader.refused).toEqual(['boardDraw needs permission "workspace:draw"']);

  const drawer = fakeHost({ features: ["board"], capabilities: ["workspace:draw"] });
  const hm2 = await drawer.connect();
  expect(() => hm2.board.read()).toThrow('needs permission "workspace:board"');
  expect(() => hm2.board.on(() => {})).toThrow('needs permission "workspace:board"');
  const raw = hm2 as unknown as { send(m: unknown): void };
  raw.send({ type: "subscribeBoard" });
  raw.send({ type: "request", requestId: 91, name: "boardRead", args: [{}] });
  raw.send({ type: "request", requestId: 92, name: "boardChange", args: [{ color: "blue" }] });
  raw.send({ type: "request", requestId: 93, name: "boardErase", args: [{ page: 7 }] });
  raw.send({ type: "request", requestId: 94, name: "boardUndo", args: [{ writer: "person" }] });
  await drawer.settle();
  expect(drawer.refused).toEqual([
    'subscribeBoard needs permission "workspace:board"',
    'boardRead needs permission "workspace:board"',
    "request: ids must name what to change",
    "request: page must be a page's id or null",
    "request: boardUndo takes no options",
  ]);
});

test("a follower hears each change the host sends, and the host is told when the last one stops", async () => {
  const host = fakeHost({ features: ["board"], capabilities: ["workspace:board"] });
  const hm = await host.connect();
  const heard: ViewBoardChange[] = [];
  const stop = hm.board.on((c) => heard.push(c));
  host.send({ type: "board", changed: ["s1", "s2"], removed: [], page: "p1" });
  host.send({ type: "board", changed: [], removed: ["s3"] });
  await host.settle();
  expect(heard).toEqual([{ changed: ["s1", "s2"], removed: [], page: "p1" }, { changed: [], removed: ["s3"] }]);
  stop();
  await host.settle();
  expect(host.received.map((m) => m.type).filter((t) => t.endsWith("Board"))).toEqual(["subscribeBoard", "unsubscribeBoard"]);
});

test("a host without the feature: the view is told it cannot, and nothing is sent", async () => {
  const host = fakeHost({ features: [], capabilities: ["workspace:board", "workspace:draw"] });
  const hm = await host.connect();
  expect(hm.supports("board")).toBe(false);
  await expect(hm.board.draw({ shapes: [] })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  hm.board.on(() => {});
  await host.settle();
  expect(host.received.filter((m) => m.type === "request" || m.type === "subscribeBoard")).toEqual([]);
});
