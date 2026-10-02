// What a view is told the workspace holds (`structure`), as the window and a device both build it:
// each frame with the colour and machine its host resolves, the frame it nests in, its branch and
// its folder by name alone; each tile in its frame (or none), by its name or else its label, with
// its agent; and the links between agents, nothing more of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewStructure } from "../src/structure.ts";

test("frames, tiles and links as the protocol says, the host's colours and machines, the folders by name alone", () => {
  const frames = [
    { id: "f1", title: "api", workspacePath: "/home/priya/api", color: "oklch(0.72 0.075 240)" },
    { id: "f2", title: "nav", parentFrameId: "f1", branch: "fix-nav", worktreePath: "/home/priya/api/.worktrees/fix-nav", workspacePath: "/home/priya/api", color: "#123456" },
    { id: "f3", title: "build box", workspacePath: "machine://m1/srv/api", color: "#abcdef" },
    { id: "f4", title: "Group 4", color: "#000000" },
  ];
  const tiles = [
    { id: "t1", kind: "claude", label: "Claude #1" },
    { id: "t2", kind: "shell", label: "Shell #1" },
    { id: "t3", kind: "editor", label: "Editor" },
  ];
  const message = viewStructure({
    frames, tiles,
    frameOf: { t1: "f1", t2: "f2" },
    name: (t) => (t.id === "t1" ? "Fixing the nav" : undefined),
    agent: (t) => (t.kind === "claude" ? "claude" : undefined),
    links: { pipes: [{ src: "t1", dst: "t2", since: 1 } as { src: string; dst: string }], spawns: [{ parent: "t1", child: "t2" }] },
    color: (f) => (f.color.startsWith("#") ? f.color : "#8cb4e5"),
    machine: (f) => (f.workspacePath?.startsWith("machine://") ? { name: "build box", state: "online" } : undefined),
  });
  assert.deepEqual(message, {
    type: "structure",
    frames: [
      { id: "f1", title: "api", color: "#8cb4e5", folder: { name: "api", kind: "folder" } },
      { id: "f2", title: "nav", color: "#123456", parentId: "f1", branch: "fix-nav", folder: { name: "fix-nav", kind: "worktree" } },
      { id: "f3", title: "build box", color: "#abcdef", machine: { name: "build box", state: "online" }, folder: { name: "api", kind: "folder" } },
      { id: "f4", title: "Group 4", color: "#000000" },
    ],
    tiles: [
      { id: "t1", frameId: "f1", kind: "claude", name: "Fixing the nav", agent: "claude" },
      { id: "t2", frameId: "f2", kind: "shell", name: "Shell #1" },
      { id: "t3", frameId: null, kind: "editor", name: "Editor" },
    ],
    links: { pipes: [{ src: "t1", dst: "t2" }], spawns: [{ parent: "t1", child: "t2" }] },
  });
});
