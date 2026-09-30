// The workspace store through its public API, against a real directory: what it keeps, the file
// format existing installs depend on, what it refuses, and what it does when the disk fails.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/store.ts";

let tmp: string;
let dir: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-store-"));
  dir = path.join(tmp, "workspaces");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], tileNames: {}, editorTabs: {}, frameOf: { t1: "f1" } });
const note = (text: string) => ({ id: "n1", kind: "note" as const, x: 10, y: 20, w: 200, h: 160, text });
const list = (...items: string[]) =>
  ({ id: "c1", kind: "checklist" as const, x: 0, y: 200, w: 240, h: 200, text: "today", items: items.map((text, i) => ({ id: `i${i + 1}`, text, done: false })) });
const restart = () => new WorkspaceStore({ dir });

// Repo "/work/api" is stored under the first 32 hex digits of sha256("/work/api"). Files already on
// users' disks are found by this name, so it is spelled out here rather than computed.
const API = "c24c3b6218aa37d36397127da76a9abd";
// What the first version of the format wrote for "/work/api": a header line, then the document.
// Never regenerate it; a new format comes with a migration and a fixture of its own.
const FIXTURE = fs.readFileSync(new URL(`fixtures/${API}.loro`, import.meta.url));
const header = (fields: object) => Buffer.from(`${JSON.stringify(fields)}\n`);
const document = FIXTURE.subarray(FIXTURE.indexOf(0x0a) + 1);

test("a workspace's layout is kept per repo and is there after a restart, as is a change made after it", () => {
  const s = new WorkspaceStore({ dir });
  s.setCore("/a", core("api"));
  s.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  s.setView("/a", "windows", { v: 1, data: { tab: "t1" } });
  s.setObjects("/a", [note("ship it")]);

  const again = restart();
  expect(again.getCore("/a")).toEqual(core("api"));
  expect(again.getView("/a", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  expect(again.getViews("/a")).toEqual({ canvas: { v: 2, data: { positions: { t1: { x: 1, y: 2 } } } }, windows: { v: 1, data: { tab: "t1" } } });
  expect(again.getObjects("/a")).toEqual([note("ship it")]);
  expect(again.getView("/a", "board")).toBeNull();
  expect(again.getCore("/b")).toBeNull();
  expect(again.getViews("/b")).toEqual({});
  expect(again.getObjects("/b")).toEqual([]);

  again.setCore("/a", core("renamed"));
  expect(restart().getCore("/a")).toEqual(core("renamed"));
});

test("what callers give and get are copies, so changing one changes nothing stored", () => {
  const s = new WorkspaceStore({ dir });
  const given = core("api");
  s.setCore("/a", given);
  given.frames[0]!.title = "changed after set";
  const got = s.getCore("/a") as ReturnType<typeof core>;
  got.frames[0]!.title = "changed after get";
  expect(s.getCore("/a")).toEqual(core("api"));
  expect(restart().getCore("/a")).toEqual(core("api"));
});

test("a document the first version of the format wrote, under its hashed name, loads", () => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${API}.loro`), FIXTURE);
  const s = new WorkspaceStore({ dir });
  expect(s.getCore("/work/api")).toEqual({
    frames: [{ id: "repo", title: "api", workspacePath: "/work/api" }, { id: "wt", title: "fix", parentFrameId: "repo", branch: "fix" }],
    tiles: [{ id: "t1", kind: "claude", label: "Claude" }, { id: "ed", kind: "editor", label: "Editor" }],
    tileNames: { t1: "reviewer" },
    editorTabs: { ed: ["src/a.ts"] },
    frameOf: { t1: "wt" },
  });
  expect(s.getView("/work/api", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1.5 } } });
});

test("files are private, leave no temp files, and stay inside the directory whatever the repo", () => {
  const s = new WorkspaceStore({ dir });
  s.setCore("/a", core("x"));
  s.setCore("../../escape", core("y"));
  const files = fs.readdirSync(dir);
  expect(files).toHaveLength(2);
  expect(files.every((f) => /^[0-9a-f]{32}\.loro$/.test(f))).toBe(true);
  if (process.platform !== "win32") {
    for (const f of files) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  }
});

test.each([
  ["empty", Buffer.alloc(0)],
  ["another format version", Buffer.concat([header({ format: "hivemind-workspace", v: 2, repo: "/work/api" }), document])],
  ["another repo's document", Buffer.concat([header({ format: "hivemind-workspace", v: 1, repo: "/elsewhere" }), document])],
  ["a document that does not load", Buffer.concat([header({ format: "hivemind-workspace", v: 1, repo: "/work/api" }), Buffer.from("not a document")])],
])("a file that is %s is set aside, reported, and the workspace starts empty", (_name, content) => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${API}.loro`), content);
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir, onWarn: (m) => warnings.push(m) });

  expect(s.getCore("/work/api")).toBeNull();
  expect(warnings).toHaveLength(1);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith(`${API}.loro.corrupt-`));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, aside[0]!)).equals(content)).toBe(true);

  s.setCore("/work/api", core("fresh"));
  expect(restart().getCore("/work/api")).toEqual(core("fresh"));
});

test("an old layout is imported only where the store has nothing, and never replaces what it has", () => {
  const s = new WorkspaceStore({ dir });
  s.importLegacy("/a", { core: core("old"), views: { canvas: { v: 2, data: 1 } } });
  expect(s.getCore("/a")).toEqual(core("old"));
  expect(s.getView("/a", "canvas")).toEqual({ v: 2, data: 1 });

  s.setCore("/a", core("new"));
  s.setView("/a", "canvas", { v: 2, data: 2 });
  s.importLegacy("/a", { core: core("older"), views: { canvas: { v: 2, data: 0 }, windows: { v: 1, data: {} } } });

  const again = restart();
  expect(again.getCore("/a")).toEqual(core("new"));
  expect(again.getView("/a", "canvas")).toEqual({ v: 2, data: 2 });
  expect(again.getView("/a", "windows")).toEqual({ v: 1, data: {} });
});

test("an old entry that cannot be a layout is skipped and reported, and the rest still comes across", () => {
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir, onWarn: (m) => warnings.push(m) });
  s.importLegacy("/a", { core: ["not", "a", "layout"], views: { bogus: { nope: true }, canvas: { v: 1, data: 3 } } });

  expect(warnings).toHaveLength(2);
  const again = restart();
  expect(again.getCore("/a")).toBeNull();
  expect(again.getView("/a", "bogus")).toBeNull();
  expect(again.getView("/a", "canvas")).toEqual({ v: 1, data: 3 });
});

test("undo takes back board edits one write at a time, never the layout or a view; redo makes them again; both are saved", () => {
  const s = new WorkspaceStore({ dir });
  // A window's first save of an empty board changes nothing, so it leaves nothing to take back.
  s.setObjects("/a", []);
  s.setObjects("/a", [note("draft"), list("milk")]);
  s.setObjects("/a", [note("drafted"), list("milk", "eggs")]); // at once, and still a step of its own
  s.setCore("/a", core("api"));
  s.setView("/a", "canvas", { v: 1, data: { zoom: 2 } });

  expect(s.undo("/a")).toBe(true);
  expect(s.getObjects("/a")).toEqual([list("milk"), note("draft")]);
  expect(restart().getObjects("/a")).toEqual([list("milk"), note("draft")]);
  expect(s.redo("/a")).toBe(true);
  expect(s.getObjects("/a")).toEqual([list("milk", "eggs"), note("drafted")]);
  expect(s.undo("/a")).toBe(true);
  expect(s.undo("/a")).toBe(true);
  expect(s.getObjects("/a")).toEqual([]);
  expect(s.undo("/a")).toBe(false);
  expect(s.getCore("/a")).toEqual(core("api"));
  expect(s.getView("/a", "canvas")).toEqual({ v: 1, data: { zoom: 2 } });

  expect(s.redo("/a")).toBe(true);
  expect(s.redo("/a")).toBe(true);
  expect(s.redo("/a")).toBe(false);
  expect(s.getObjects("/a")).toEqual([list("milk", "eggs"), note("drafted")]);
  expect(restart().getObjects("/a")).toEqual([list("milk", "eggs"), note("drafted")]);
});

test("each writer undoes and redoes its own board edits, never another's", () => {
  const s = new WorkspaceStore({ dir });
  s.setObjects("/a", [note("draft")], { writer: "window:1" });
  s.setObjects("/a", [note("draft"), list("milk")], { writer: "window:12", base: [note("draft")] });
  s.setObjects("/a", [note("drafted"), list("milk")], { writer: "window:1", base: [note("draft"), list("milk")] });
  expect(s.undo("/a", { writer: "window:12" })).toBe(true);
  expect(s.getObjects("/a")).toEqual([note("drafted")]);
  expect(s.undo("/a", { writer: "window:12" })).toBe(false);
  expect(s.undo("/a", { writer: "window:1" })).toBe(true);
  expect(s.getObjects("/a")).toEqual([note("draft")]);
  expect(s.redo("/a", { writer: "window:12" })).toBe(true);
  expect(s.getObjects("/a")).toEqual([list("milk"), note("draft")]);
  expect(s.undo("/a", { writer: "window:1" })).toBe(true);
  expect(s.getObjects("/a")).toEqual([list("milk")]);
});

test("a writer that is gone takes its board history with it; what it wrote stays, and the others keep theirs", () => {
  const s = new WorkspaceStore({ dir });
  s.getObjects("/b"); // another open workspace, where the writer never wrote
  s.setObjects("/a", [note("draft")], { writer: "window:1" });
  s.setObjects("/a", [note("draft"), list("milk")], { writer: "window:2", base: [note("draft")] });
  s.setObjects("/c", [note("elsewhere")], { writer: "window:1" });
  s.forgetWriter("window:1");
  s.forgetWriter("window:9"); // never wrote: nothing to forget
  expect(s.undo("/a", { writer: "window:1" })).toBe(false);
  expect(s.undo("/c", { writer: "window:1" })).toBe(false);
  expect(s.getObjects("/c")).toEqual([note("elsewhere")]);
  expect(s.getObjects("/a")).toEqual([list("milk"), note("draft")]);
  expect(s.undo("/a", { writer: "window:2" })).toBe(true);
  expect(s.getObjects("/a")).toEqual([note("draft")]);
});

test("a view or a board another window changed keeps that change when a window then writes what it read before", () => {
  const s = new WorkspaceStore({ dir });
  const canvas = (positions: object) => ({ v: 1, data: { positions } });
  s.setView("/a", "canvas", canvas({ t1: { x: 0, y: 0 }, t2: { x: 100, y: 0 } }), { writer: "window:1" });
  s.setObjects("/a", [note("draft")], { writer: "window:1" });
  const view = s.getView("/a", "canvas");
  const board = s.getObjects("/a");
  s.setView("/a", "canvas", canvas({ t1: { x: 0, y: 0 }, t2: { x: 150, y: 50 } }), { writer: "window:2", base: view });
  s.setObjects("/a", [note("draft"), list("milk")], { writer: "window:2", base: board });
  s.setView("/a", "canvas", canvas({ t1: { x: 10, y: 10 }, t2: { x: 100, y: 0 } }), { writer: "window:1", base: view });
  s.setObjects("/a", [note("drafted")], { writer: "window:1", base: board });
  expect(restart().getView("/a", "canvas")).toEqual(canvas({ t1: { x: 10, y: 10 }, t2: { x: 150, y: 50 } }));
  expect(restart().getObjects("/a")).toEqual([list("milk"), note("drafted")]);
});

test("bad input is refused with a TypeError and stores nothing", () => {
  const s = new WorkspaceStore({ dir });
  const bad: Array<() => unknown> = [
    () => s.setCore("", core("x")),
    () => s.setCore(42 as never, core("x")),
    () => s.getCore(undefined as never),
    () => s.setCore("/a", "not a layout"),
    () => s.setView("/a", "canvas", { data: {} } as never),
    () => s.setObjects("/a", { n1: note("not a list") }),
    () => s.undo(""),
    () => s.importLegacy("/a", 42 as never),
  ];
  for (const call of bad) expect(call).toThrow(TypeError);
  expect(s.getCore("/a")).toBeNull();
  expect(fs.existsSync(dir)).toBe(false);
});

test("a write the disk refuses is kept, reported, and written by flush once it can be", () => {
  const blocker = path.join(tmp, "blocked");
  fs.writeFileSync(blocker, "a file where the store's directory should be");
  const blockedDir = path.join(blocker, "workspaces");
  const warnings: string[] = [];
  const s = new WorkspaceStore({ dir: blockedDir, onWarn: (m) => warnings.push(m) });

  s.setCore("/a", core("kept"));
  expect(warnings).toHaveLength(1);
  expect(s.getCore("/a")).toEqual(core("kept"));

  fs.rmSync(blocker);
  s.flush();
  expect(new WorkspaceStore({ dir: blockedDir }).getCore("/a")).toEqual(core("kept"));
});

test("each change is told, with who made it; a write that changes nothing is not", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, onChange: (c) => told.push(c) });
  s.setCore("/a", core("api"), { writer: "window:1" });
  s.setCore("/a", core("api"), { writer: "window:1" });
  s.setView("/a", "canvas", { v: 1, data: { positions: {} } }, { writer: "window:2" });
  s.setObjects("/a", [note("ship it")], { writer: "window:1" });
  s.undo("/a", { writer: "window:2" }); // nothing of its own to take back
  s.undo("/a", { writer: "window:1" });
  expect(s.renameTile("t1", "reviewer", { writer: "control" })).toBe("/a");
  expect(told).toEqual([
    { repo: "/a", part: "core", writer: "window:1" },
    { repo: "/a", part: "view:canvas", writer: "window:2" },
    { repo: "/a", part: "board", writer: "window:1" },
    { repo: "/a", part: "board", writer: "window:1" },
    { repo: "/a", part: "core", writer: "control" },
  ]);
});

test("a tile named by the control plane keeps its name when a window then writes what it read before", () => {
  const s = new WorkspaceStore({ dir });
  s.setCore("/a", core("api"));
  s.getCore("/b"); // another open workspace, without the tile
  const read = s.getCore("/a");
  expect(s.renameTile("t1", "reviewer")).toBe("/a");
  expect(s.renameTile("nowhere", "x")).toBeNull();
  s.setCore("/a", core("moved"), { base: read });
  expect(restart().getCore("/a")).toEqual({ ...core("moved"), tileNames: { t1: "reviewer" } });
});

test("a tile closed by the control plane is gone after a restart, and stays closed when a window then writes what it read before", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, onChange: (c) => told.push(c) });
  s.getCore("/b"); // another open workspace, without the tile
  s.setCore("/a", core("api"), { writer: "window:1" });
  const read = s.getCore("/a");
  expect(s.removeTile("nowhere", { writer: "control" })).toBeNull();
  expect(s.removeTile("t1", { writer: "control" })).toEqual({ repo: "/a", tile: { id: "t1", kind: "claude" } });
  expect(restart().getCore("/a")).toEqual({ ...core("api"), tiles: [], frameOf: {} });
  s.setCore("/a", core("moved"), { base: read, writer: "window:1" });
  expect(restart().getCore("/a")).toEqual({ ...core("moved"), tiles: [], frameOf: {} });
  expect(told).toEqual([
    { repo: "/a", part: "core", writer: "window:1" },
    { repo: "/a", part: "core", writer: "control" },
    { repo: "/a", part: "core", writer: "window:1" },
  ]);
});

test("a tile the control plane opens is kept, told with its writer, and stays when a window then writes what it read before", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, onChange: (c) => told.push(c) });
  s.setCore("/a", core("api"), { writer: "window:1" });
  const read = s.getCore("/a");
  const t2 = { id: "t2", kind: "shell", label: "shell #1" };
  expect(s.addTile("/a", t2, { frame: "f1", name: "server" }, { writer: "control" })).toBe(true);
  expect(s.addTile("/a", { ...t2, label: "again" }, {}, { writer: "control" })).toBe(false);
  s.setCore("/a", core("moved"), { base: read, writer: "window:1" });
  expect(restart().getCore("/a")).toEqual({ ...core("moved"), tiles: [...core("moved").tiles, t2], tileNames: { t2: "server" }, frameOf: { t1: "f1", t2: "f1" } });
  expect(told).toEqual([
    { repo: "/a", part: "core", writer: "window:1" },
    { repo: "/a", part: "core", writer: "control" },
    { repo: "/a", part: "core", writer: "window:1" },
  ]);
});
