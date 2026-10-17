// Who is in a workspace now (presence.ts, design §4.2 C): one participant per connection, as they
// last said; one leaves a workspace, or all of them when their connection goes; one who has said
// nothing for a minute is gone; and what a client sends is bounded before anyone else sees it.
import { test, expect, setSystemTime, afterEach } from "bun:test";
import { PresenceHub, presenceOf, QUIET_FOR_MS, type Participant } from "../src/presence.ts";

afterEach(() => setSystemTime());

const at = (id: string, person: string, x: number): Participant => ({ id, person, name: person, color: "", cursor: { x, y: 0 }, over: null, selection: [], viewport: null });

test("one participant per connection, as they last said; leaving takes them out of one workspace, or of all", () => {
  const hub = new PresenceHub();
  hub.set("/a", at("window:1", "me", 1));
  hub.set("/a", at("peer:d", "priya", 2));
  expect(hub.set("/a", at("window:1", "me", 3)).map((p) => [p.id, p.cursor?.x])).toEqual([["window:1", 3], ["peer:d", 2]]);
  hub.set("/b", at("peer:d", "priya", 4));

  expect(hub.leave("peer:d", "/b")).toEqual(["/b"]);
  expect(hub.people("/b")).toEqual([]);
  expect(hub.people("/a").map((p) => p.id)).toEqual(["window:1", "peer:d"]);
  hub.set("/b", at("peer:d", "priya", 4));
  expect(hub.leave("peer:d").sort()).toEqual(["/a", "/b"]);
  expect(hub.people("/a").map((p) => p.id)).toEqual(["window:1"]);
  expect(hub.leave("peer:d")).toEqual([]);
});

test("one who has said nothing for a minute is gone", () => {
  const hub = new PresenceHub();
  setSystemTime(new Date(1_000_000));
  hub.set("/a", at("window:1", "me", 1));
  setSystemTime(new Date(1_000_000 + QUIET_FOR_MS / 2));
  hub.set("/a", at("peer:d", "priya", 2));
  setSystemTime(new Date(1_000_000 + QUIET_FOR_MS + 1));
  expect(hub.people("/a").map((p) => p.id)).toEqual(["peer:d"]);
});

test("what a client sends is bounded: a long name cut, a colour that is not one dropped, a cursor that is not a point off the board, over nothing that is not an id", () => {
  expect(presenceOf({ name: "x".repeat(100), color: "#ABCDEF", cursor: { x: 1, y: 2 }, over: "tile-1", selection: ["t1", 2, "t2"] }))
    .toEqual({ name: "x".repeat(64), color: "#abcdef", cursor: { x: 1, y: 2 }, over: "tile-1", selection: ["t1", "t2"], viewport: null });
  expect(presenceOf({ name: 7, color: "red; background: url(x)", cursor: { x: Infinity, y: 0 }, over: "t".repeat(257), selection: Array.from({ length: 150 }, (_, i) => `t${i}`) }))
    .toEqual({ name: "", color: "", cursor: null, over: null, selection: Array.from({ length: 100 }, (_, i) => `t${i}`), viewport: null });
  expect(presenceOf({ over: 7 })?.over).toBeNull();
  expect(presenceOf("here")).toBeNull();
});

test("a live camera crosses presence, with invalid zoom rejected, and disappears when its window leaves", () => {
  const hub = new PresenceHub();
  const state = presenceOf({ viewport: { x: 120, y: -40, zoom: 1.5 } });
  expect(state?.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 });
  expect(presenceOf({ viewport: { x: 0, y: 0, zoom: Infinity } })?.viewport).toBeNull();
  hub.set("/a", { ...at("window:1", "host", 1), ...state! });
  expect(hub.people("/a")[0]?.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 });
  hub.leave("window:1", "/a");
  expect(hub.people("/a")).toEqual([]);
});
