// What someone may change in a workspace's layout by their role (edit-rules.ts, design §6):
// editing the board moves, sizes, names and groups what is on it; placing, taking away or
// changing a tile that runs something on the host is driving agents; where a frame's tiles run is
// the owner's to say; the owner may change anything. But anyone who edits the board may put a
// frame of their own on their own machine, and what runs in it (M4).
import { test, expect } from "bun:test";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { refusedEdit } from "../src/edit-rules.ts";
import type { Access } from "../src/access.ts";

/** The device the changes are made from, and a frame of theirs on it. */
const D = "d".repeat(64);
const MINE = `machine://${D}/home/priya/api`;
const before: CoreLayout = {
  frames: [{ id: "f1", title: "api", workspacePath: "/work/api" }, { id: "f2", title: "notes" }, { id: "p1", title: "Priya's", workspacePath: MINE }],
  tiles: [
    { id: "t1", kind: "shell", label: "sh", cmd: "/bin/bash" },
    { id: "a1", kind: "claude", label: "agent", cmd: "claude" },
    { id: "e1", kind: "editor", label: "README" },
    { id: "p9", kind: "shell", label: "sh", cmd: "/bin/zsh" },
  ],
  tileNames: {},
  editorTabs: {},
  frameOf: { t1: "f1", e1: "f1", p9: "p1" },
};
const shell = { id: "t9", kind: "shell", label: "sh", cmd: "/bin/sh", args: ["-c", "touch ~/owned"] };
type Change = (l: CoreLayout) => CoreLayout;
const tiles = (f: (t: CoreLayout["tiles"]) => CoreLayout["tiles"]): Change => (l) => ({ ...l, tiles: f(l.tiles) });
const frames = (f: (t: CoreLayout["frames"]) => CoreLayout["frames"]): Change => (l) => ({ ...l, frames: f(l.frames) });
const tile = (id: string, patch: Record<string, unknown>): Change => tiles((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

// [what is changed, the least role that may, or "owner"]
const cases: Array<[string, Change, Access]> = [
  ["a tile moved, sized and named", (l) => ({ ...tile("t1", { x: 40, w: 600 })(l), tileNames: { t1: "build" } }), "edit"],
  ["a frame retitled and moved", frames((fs) => fs.map((f) => (f.id === "f1" ? { ...f, title: "api (main)", x: 10 } : f))), "edit"],
  ["an agent's shown task", tile("a1", { task: "fix the tests" }), "edit"],
  ["an editor tile added", tiles((ts) => [...ts, { id: "e2", kind: "editor", label: "notes.md" }]), "edit"],
  ["an editor tile taken away", tiles((ts) => ts.filter((t) => t.id !== "e1")), "edit"],
  ["a frame with no folder added", frames((fs) => [...fs, { id: "f3", title: "ideas" }]), "edit"],
  ["a frame with no folder taken away", frames((fs) => fs.filter((f) => f.id !== "f2")), "edit"],
  ["a shell tile added", tiles((ts) => [...ts, shell]), "agents"],
  ["an agent tile added", tiles((ts) => [...ts, { id: "a9", kind: "claude", label: "agent", cmd: "claude" }]), "agents"],
  ["a browser tile added", tiles((ts) => [...ts, { id: "b9", kind: "browser", label: "web", url: "http://127.0.0.1:9222" } as never]), "agents"],
  ["a tile of a kind not known here added", tiles((ts) => [...ts, { id: "x9", kind: "mystery", label: "?", cmd: "sh" }]), "agents"],
  ["what a shell runs", tile("t1", { cmd: "/bin/sh" }), "agents"],
  ["a shell's arguments", tile("t1", { args: ["-c", "touch ~/owned"] }), "agents"],
  ["the session a tile shows", tile("t1", { session: "hm:other" }), "agents"],
  ["an editor tile made a shell", tile("e1", { kind: "shell", cmd: "/bin/sh" }), "agents"],
  ["a shell tile taken away", tiles((ts) => ts.filter((t) => t.id !== "t1")), "agents"],
  ["a shell moved to another frame", (l) => ({ ...l, frameOf: { ...l.frameOf, t1: "f2" } }), "agents"],
  ["a frame's folder", frames((fs) => fs.map((f) => (f.id === "f1" ? { ...f, workspacePath: "/" } : f))), "owner"],
  ["a frame put on another machine", frames((fs) => fs.map((f) => (f.id === "f2" ? { ...f, workspacePath: "ssh://me@box/home" } : f))), "owner"],
  ["a frame's worktree", frames((fs) => fs.map((f) => (f.id === "f2" ? { ...f, branch: "x", worktreePath: "/tmp/x" } : f))), "owner"],
  ["a frame nested in another", frames((fs) => fs.map((f) => (f.id === "f2" ? { ...f, parentFrameId: "f1" } : f))), "owner"],
  ["a frame added with a folder", frames((fs) => [...fs, { id: "f3", title: "etc", workspacePath: "/etc" }]), "owner"],
  ["a frame with a folder taken away", frames((fs) => fs.filter((f) => f.id !== "f1")), "owner"],
  // Their own frame on their own machine, and what runs in it.
  ["a frame of theirs put on their machine", frames((fs) => [...fs, { id: "p2", title: "web", workspacePath: `machine://${D}/home/priya/web` }]), "edit"],
  ["their frame moved to another folder of theirs", frames((fs) => fs.map((f) => (f.id === "p1" ? { ...f, workspacePath: `machine://${D}/tmp/x` } : f))), "edit"],
  ["a shell placed in their frame", (l) => ({ ...tiles((ts) => [...ts, shell])(l), frameOf: { ...l.frameOf, t9: "p1" } }), "edit"],
  ["what runs in their frame", tile("p9", { cmd: "/bin/sh", args: ["-c", "make"] }), "edit"],
  ["their frame and its shell taken away", (l) => ({ ...l, frames: l.frames.filter((f) => f.id !== "p1"), tiles: l.tiles.filter((t) => t.id !== "p9"), frameOf: { t1: "f1", e1: "f1" } }), "edit"],
  ["a frame put on someone else's machine", frames((fs) => [...fs, { id: "p3", title: "x", workspacePath: `machine://${"e".repeat(64)}/home` }]), "owner"],
  ["the owner's frame put on their machine", frames((fs) => fs.map((f) => (f.id === "f2" ? { ...f, workspacePath: MINE } : f))), "owner"],
  ["a frame of theirs with a worktree", frames((fs) => [...fs, { id: "p4", title: "x", workspacePath: MINE, branch: "b", worktreePath: "/tmp/b" }]), "owner"],
  ["the host's shell moved into their frame", (l) => ({ ...l, frameOf: { ...l.frameOf, t1: "p1" } }), "agents"],
  ["their shell moved into the host's frame", (l) => ({ ...l, frameOf: { ...l.frameOf, p9: "f1" } }), "agents"],
];
const ladder: Access[] = ["edit", "terminals", "agents", "owner"];

test.each(cases)("%s: changed by whoever may, refused to anyone else", (_, change, least) => {
  const after = change(structuredClone(before));
  for (const access of ladder) {
    const why = refusedEdit(before, after, access, D);
    if (ladder.indexOf(access) >= ladder.indexOf(least)) expect(why).toBeNull();
    else expect(why).toEqual(expect.any(String));
  }
});

test("nothing changed is anyone's to make; a layout there was none of before is a change like any other; a frame is theirs only from their own device", () => {
  expect(refusedEdit(before, structuredClone(before), "edit", D)).toBeNull();
  expect(refusedEdit(null, { frames: [], tiles: [shell] }, "edit", D)).toMatch(/driving agents/);
  expect(refusedEdit(null, { frames: [{ id: "f", title: "x" }], tiles: [] }, "edit", D)).toBeNull();
  const theirs = frames((fs) => [...fs, { id: "p2", title: "web", workspacePath: `machine://${D}/home/priya/web` }])(structuredClone(before));
  expect(refusedEdit(before, theirs, "edit")).toMatch(/owner's to say/);
});
