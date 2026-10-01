// What someone may change in a workspace's layout by their role (edit-rules.ts, design §6):
// editing the board moves, sizes, names and groups what is on it; placing, taking away or
// changing a tile that runs something on the host is driving agents; where a frame's tiles run is
// the owner's to say; the owner may change anything.
import { test, expect } from "bun:test";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { refusedEdit } from "../src/edit-rules.ts";
import type { Access } from "../src/access.ts";

const before: CoreLayout = {
  frames: [{ id: "f1", title: "api", workspacePath: "/work/api" }, { id: "f2", title: "notes" }],
  tiles: [
    { id: "t1", kind: "shell", label: "sh", cmd: "/bin/bash" },
    { id: "a1", kind: "claude", label: "agent", cmd: "claude" },
    { id: "e1", kind: "editor", label: "README" },
  ],
  tileNames: {},
  editorTabs: {},
  frameOf: { t1: "f1", e1: "f1" },
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
];
const ladder: Access[] = ["edit", "terminals", "agents", "owner"];

test.each(cases)("%s: changed by whoever may, refused to anyone else", (_, change, least) => {
  const after = change(structuredClone(before));
  for (const access of ladder) {
    const why = refusedEdit(before, after, access);
    if (ladder.indexOf(access) >= ladder.indexOf(least)) expect(why).toBeNull();
    else expect(why).toEqual(expect.any(String));
  }
});

test("nothing changed is anyone's to make; a layout there was none of before is a change like any other", () => {
  expect(refusedEdit(before, structuredClone(before), "edit")).toBeNull();
  expect(refusedEdit(null, { frames: [], tiles: [shell] }, "edit")).toMatch(/driving agents/);
  expect(refusedEdit(null, { frames: [{ id: "f", title: "x" }], tiles: [] }, "edit")).toBeNull();
});
