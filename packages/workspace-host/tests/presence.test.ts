// Who is in a workspace now (presence.ts, design §4.2 C): one participant per connection, as they
// last said; one leaves a workspace, or all of them when their connection goes; one who has said
// nothing for a minute is gone; and what a client sends is bounded before anyone else sees it.
import { test, expect, setSystemTime, afterEach } from "bun:test";
import { PresenceHub, presenceOf, QUIET_FOR_MS, type Participant } from "../src/presence.ts";

afterEach(() => setSystemTime());

const at = (id: string, person: string, x: number): Participant => ({ id, person, name: person, color: "", cursor: { x, y: 0 }, selection: [] });

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

test("what a client sends is bounded: a long name cut, a colour that is not one dropped, a cursor that is not a point off the board", () => {
  expect(presenceOf({ name: "x".repeat(100), color: "#ABCDEF", cursor: { x: 1, y: 2 }, selection: ["t1", 2, "t2"] }))
    .toEqual({ name: "x".repeat(64), color: "#abcdef", cursor: { x: 1, y: 2 }, selection: ["t1", "t2"] });
  expect(presenceOf({ name: 7, color: "red; background: url(x)", cursor: { x: Infinity, y: 0 }, selection: Array.from({ length: 150 }, (_, i) => `t${i}`) }))
    .toEqual({ name: "", color: "", cursor: null, selection: Array.from({ length: 100 }, (_, i) => `t${i}`) });
  expect(presenceOf("here")).toBeNull();
});
