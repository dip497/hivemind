// Typing into several terminals at once: what a terminal does with a key while a group is on. Keys
// go to every member, Escape ends it and goes nowhere, a terminal outside the group keeps its own,
// and a group short of two is none (nothing is half on).
import { test } from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { broadcastHeld, broadcastTiles, endBroadcastOf, keepBroadcastTiles, personInputOf, setBroadcastGroup, setTerminalTypable, typedIntoTerminal } from "../../src/renderer/src/workspace/broadcast-input.ts";

const writes: string[] = [];
const write = (pty: string, data: string) => { writes.push(`${pty}:${data}`); };
const view = {};
const typed = (from: string, data: string) => typedIntoTerminal(from, data, true, write);

test("a key typed into a member goes to every member, and not again on its own", () => {
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }], view);
  writes.length = 0;
  assert.equal(typed("a", "ls\r"), false);
  assert.deepEqual(writes, ["pa:ls\r", "pb:ls\r"]);
  writes.length = 0;
  assert.equal(typed("c", "x"), true, "a terminal outside the group sends its own");
  assert.deepEqual(writes, []);
  assert.equal(typed("a", "\x1b[A"), false, "an arrow key is not Escape");
  setBroadcastGroup([], view);
});

test("Escape alone ends the group and is sent to none of them", () => {
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }], view);
  writes.length = 0;
  assert.equal(typed("b", "\x1b"), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(broadcastTiles(), []);
  assert.equal(typed("a", "y"), true, "after it, each terminal is its own again");
});

test("a group of one is none, and one whose member closed down to one ends", () => {
  setBroadcastGroup([{ tile: "a", pty: "pa" }], view);
  assert.deepEqual(broadcastTiles(), []);
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }, { tile: "c", pty: "pc" }], view);
  keepBroadcastTiles(view, (id) => id !== "c");
  assert.deepEqual(broadcastTiles(), ["a", "b"]);
  keepBroadcastTiles(view, (id) => id === "a");
  assert.deepEqual(broadcastTiles(), []);
});

test("a member whose keyboard someone else holds is skipped and listed as held, until it is this person's again", () => {
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }, { tile: "c", pty: "pc" }], view);
  setTerminalTypable("b", false);
  assert.deepEqual(broadcastHeld(), ["b"]);
  writes.length = 0;
  typed("a", "z");
  assert.deepEqual(writes, ["pa:z", "pc:z"]);
  setTerminalTypable("b", true);
  assert.deepEqual(broadcastHeld(), []);
  writes.length = 0;
  typed("a", "z");
  assert.deepEqual(writes, ["pa:z", "pb:z", "pc:z"]);
  setBroadcastGroup([], view);
});

test("a terminal's replies to its program and its mouse reports stay its own; only what the person typed is copied", async () => {
  const term = new headless.Terminal({ allowProposedApi: true, cols: 40, rows: 5 });
  const byPerson = personInputOf(term);
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }], view);
  writes.length = 0;
  const own: string[] = [];
  term.onData((d) => { if (typedIntoTerminal("a", d, byPerson(), write)) own.push(d); });
  term.input("ls\r", true);
  await new Promise<void>((done) => term.write("\x1b[6n\x1b[c", done));
  term.input("\x1b[<0;3;4M", true);
  assert.deepEqual(writes, ["pa:ls\r", "pb:ls\r"]);
  assert.deepEqual(own, ["\x1b[1;1R", "\x1b[?1;2c", "\x1b[<0;3;4M"]);
  setBroadcastGroup([], null);
  term.dispose();
});

test("the group ends with the view that set it, and only that view's closed tiles leave it", () => {
  const other = {};
  setBroadcastGroup([{ tile: "a", pty: "pa" }, { tile: "b", pty: "pb" }, { tile: "c", pty: "pc" }], view);
  keepBroadcastTiles(other, (id) => id === "a");
  endBroadcastOf(other);
  assert.deepEqual(broadcastTiles(), ["a", "b", "c"], "another view's tiles and its going say nothing");
  endBroadcastOf(view);
  assert.deepEqual(broadcastTiles(), []);
  assert.equal(typed("a", "x"), true, "nothing is copied once the view is gone");
});
