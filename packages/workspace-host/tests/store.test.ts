// The workspace store through its public API, against a real directory: what it keeps, the file
// format existing installs depend on, what it refuses, and what it does when the disk fails.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LoroDoc } from "loro-crdt";
import { readCore, writeCore } from "@hivemind/workspace-doc/core";
import { RefusedImport, WorkspaceStore, type CoreLayout, type WorkspaceChange } from "../src/store.ts";
import { refusedEdit } from "../src/edit-rules.ts";
import { writeBoard } from "./board.ts";
import { readDoc } from "../src/doc-file.ts";
import { idOf, newSeed, workspaceSeed } from "../src/identity.ts";

let tmp: string;
let dir: string;
/** This machine's person key, the same across the store's restarts. */
const person = newSeed();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ws-store-"));
  dir = path.join(tmp, "workspaces");
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const core = (title: string) => ({ frames: [{ id: "f1", title }], tiles: [{ id: "t1", kind: "claude" }], tileNames: {}, editorTabs: {}, frameOf: { t1: "f1" } });
const note = (text: string) => ({ id: "n1", kind: "widget" as const, widget: "note", placement: "board" as const, x: 10, y: 20, w: 200, h: 160, text });
const list = (...items: string[]) =>
  ({ id: "c1", kind: "widget" as const, widget: "checklist", placement: "board" as const, x: 0, y: 200, w: 240, h: 200, text: "today", items: items.map((text, i) => ({ id: `i${i + 1}`, text, done: false })) });
const restart = () => new WorkspaceStore({ dir, person });

// Repo "/work/api" is stored under the first 32 hex digits of sha256("/work/api"). Files already on
// users' disks are found by this name, so it is spelled out here rather than computed.
const API = "c24c3b6218aa37d36397127da76a9abd";
// What the first version of the format wrote for "/work/api": a header line, then the document.
// Never regenerate it; a new format comes with a migration and a fixture of its own.
const FIXTURE = fs.readFileSync(new URL(`fixtures/${API}.loro`, import.meta.url));
const header = (fields: object) => Buffer.from(`${JSON.stringify(fields)}\n`);
const document = FIXTURE.subarray(FIXTURE.indexOf(0x0a) + 1);

test("a workspace's layout is kept per repo and is there after a restart, as is a change made after it", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  s.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 1, y: 2 } } } });
  s.setView("/a", "windows", { v: 1, data: { tab: "t1" } });
  writeBoard(s, "/a", [note("ship it")]);

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

test("what callers give is copied and what they get cannot be changed, so nothing stored changes", () => {
  const s = new WorkspaceStore({ dir, person });
  const given = core("api");
  s.setCore("/a", given);
  given.frames[0]!.title = "changed after set";
  const got = s.getCore("/a") as ReturnType<typeof core>;
  expect(() => { got.frames[0]!.title = "changed after get"; }).toThrow(TypeError);
  expect(s.getCore("/a")).toEqual(core("api"));
  expect(restart().getCore("/a")).toEqual(core("api"));
});

test("a layout read before a change is read as it is after the change, whichever way it changed", () => {
  const changes: [string, (s: WorkspaceStore) => void, (s: WorkspaceStore) => unknown, unknown][] = [
    ["set", (s) => s.setCore("/a", core("renamed")), (s) => s.getCore("/a")?.frames[0]?.title, "renamed"],
    ["tile added", (s) => s.addTile("/a", { id: "t2", kind: "shell", label: "shell" }), (s) => s.getCore("/a")?.tiles.map((t) => t.id), ["t1", "t2"]],
    ["tile named", (s) => s.renameTile("t1", "reviewer"), (s) => s.getCore("/a")?.tileNames?.t1, "reviewer"],
    ["tile removed", (s) => s.removeTile("t1"), (s) => s.getCore("/a")?.tiles.length, 0],
    ["forgotten", (s) => s.forget("/a"), (s) => [s.repos(), s.getCore("/a")], [[], null]],
  ];
  for (const [what, change, read, expected] of changes) {
    fs.rmSync(dir, { recursive: true, force: true });
    const s = new WorkspaceStore({ dir, person });
    s.setCore("/a", core("api"));
    expect([what, s.repos(), s.getCore("/a")?.frames[0]?.title]).toEqual([what, ["/a"], "api"]);
    change(s);
    expect([what, read(s)]).toEqual([what, expected]);
  }
  const old = new WorkspaceStore({ dir: path.join(tmp, "legacy"), person });
  expect(old.getCore("/a")).toBeNull();
  old.importLegacy("/a", { core: core("old") });
  expect(old.getCore("/a")).toEqual(core("old"));
});

test("a document the first version of the format wrote, under its hashed name, loads", () => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${API}.loro`), FIXTURE);
  const s = new WorkspaceStore({ dir, person });
  expect(s.getCore("/work/api")).toEqual({
    frames: [{ id: "repo", title: "api", workspacePath: "/work/api" }, { id: "wt", title: "fix", parentFrameId: "repo", branch: "fix" }],
    tiles: [{ id: "t1", kind: "claude", label: "Claude" }, { id: "ed", kind: "editor", label: "Editor" }],
    tileNames: { t1: "reviewer" },
    editorTabs: { ed: ["src/a.ts"] },
    frameOf: { t1: "wt" },
  });
  expect(s.getView("/work/api", "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 10, y: 20 } }, viewport: { x: 0, y: 0, zoom: 1.5 } } });
});

/** What the document on disk for `repo` says of whose it is. */
function ownership(repo: string) {
  const meta = readDoc(dir, repo, (m) => { throw new Error(m); }).getMap("meta");
  return { workspaceId: meta.get("workspaceId"), owner: meta.get("owner"), workspacePublicKey: meta.get("workspacePublicKey") };
}

test("each workspace says whose it is: an id of its own, this person, and the workspace key they derive; kept from then on", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  writeBoard(s, "/b", [note("ship it")]);
  const a = ownership("/a");
  expect(a.workspaceId).toMatch(/^[0-9a-f]{32}$/);
  expect(ownership("/b").workspaceId).not.toBe(a.workspaceId);
  expect(a.owner).toBe(idOf(person));
  expect(a.workspacePublicKey).toBe(idOf(workspaceSeed(person, a.workspaceId as string)));
  restart().setCore("/a", core("api, again"));
  expect(ownership("/a")).toEqual(a);
});

test("a workspace is found by its id, whether it is open or only on disk; an id no workspace has finds none", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  s.setCore("/b", core("web"));
  const b = s.ownership("/b")!.workspaceId as string;
  expect(s.repoOf(b)).toBe("/b");
  expect(s.repos().sort()).toEqual(["/a", "/b"]);
  // A store that has not opened it yet finds it on disk.
  expect(restart().repoOf(b)).toBe("/b");
  expect(restart().repoOf("0".repeat(32))).toBeNull();
});

test("a workspace from before workspaces had owners is this person's from its next write; one that says whose it is stays theirs", () => {
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${API}.loro`), FIXTURE);
  const s = new WorkspaceStore({ dir, person });
  s.setView("/work/api", "windows", { v: 1, data: { tab: "t1" } });
  const mine = ownership("/work/api");
  expect(mine.owner).toBe(idOf(person));
  expect(mine.workspaceId).toMatch(/^[0-9a-f]{32}$/);
  expect(restart().getCore("/work/api")?.tileNames).toEqual({ t1: "reviewer" });
  // The same document on a machine holding another person's key.
  new WorkspaceStore({ dir, person: newSeed() }).setView("/work/api", "windows", { v: 1, data: { tab: "ed" } });
  expect(ownership("/work/api")).toEqual(mine);
});

test("a machine that takes another person moves the workspaces it owned to that person, and nobody else's; told, kept, and new ones are that person's", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/mine", core("api"));
  s.setCore("/also-mine", core("web"));
  // Someone else's, on this disk: a workspace whose document says it is theirs.
  const someone = newSeed();
  new WorkspaceStore({ dir, person: someone }).setCore("/theirs", core("theirs"));
  const told: string[] = [];
  const watched = new WorkspaceStore({ dir, person, onChange: (c) => told.push(c.repo) });
  const before = { mine: ownership("/mine"), theirs: ownership("/theirs") };

  const taken = newSeed();
  expect(watched.takePerson(taken).sort()).toEqual(["/also-mine", "/mine"]);
  const after = ownership("/mine");
  expect(after.workspaceId).toBe(before.mine.workspaceId);
  expect(after.owner).toBe(idOf(taken));
  expect(after.workspacePublicKey).toBe(idOf(workspaceSeed(taken, after.workspaceId as string)));
  expect(ownership("/also-mine").owner).toBe(idOf(taken));
  expect(ownership("/theirs")).toEqual(before.theirs);
  // Told, so a replica of it hears; and on disk, so the store next started finds it so.
  expect(told.sort()).toEqual(["/also-mine", "/mine"]);
  expect(new WorkspaceStore({ dir, person: taken }).ownership("/mine")!.owner).toBe(idOf(taken));
  // A workspace made from here on is the new person's; taking the same person again moves nothing.
  watched.setCore("/new", core("new"));
  expect(ownership("/new").owner).toBe(idOf(taken));
  expect(watched.takePerson(taken)).toEqual([]);
});

test("a workspace handed over by another of the owner's devices keeps whose it is, every time: it is never stamped as a new one here", () => {
  // Each time with stores of their own: which of two stamps Loro would keep is down to chance.
  for (let i = 0; i < 24; i++) {
    const there = new WorkspaceStore({ dir: path.join(tmp, `there-${i}`), person });
    there.setCore("/work/api", core("api"));
    const theirs = there.ownership("/work/api");
    const here = new WorkspaceStore({ dir: path.join(tmp, `here-${i}`), person });
    here.adopt("machine://laptop/work/api", there.exportSince("/work/api", null), { writer: "host:laptop" });
    expect(here.ownership("machine://laptop/work/api")).toEqual(theirs);
    expect(here.getCore("machine://laptop/work/api")!.frames[0]!.title).toBe("api");
    expect(new WorkspaceStore({ dir: path.join(tmp, `here-${i}`), person }).ownership("machine://laptop/work/api")).toEqual(theirs);
  }
});

test("a replica catches up from what it has seen, edits merge both ways, and a replica never marks the document its own", () => {
  const host = new WorkspaceStore({ dir, person });
  const told: string[] = [];
  const replicas = path.join(tmp, "shared");
  const guest = new WorkspaceStore({ dir: replicas, onChange: (c) => told.push(`${c.part} by ${c.writer}`) });
  const R = "hive://api";
  host.setCore("/a", core("api"));
  guest.importFrom(R, host.exportSince("/a", null), { writer: "host" });
  expect(guest.getCore(R)).toEqual(core("api"));
  expect(told).toContain("core by host");
  expect(guest.ownership(R)).toEqual(host.ownership("/a"));
  // The replica has exactly what the host has: nothing of its own that could go back to the host.
  expect(guest.version(R)).toEqual(host.version("/a"));

  // Each side edits; each takes the other's changes since what it last saw.
  const hostSaw = host.version("/a");
  const guestSaw = guest.version(R);
  writeBoard(guest, R, [note("from the guest")]);
  host.setView("/a", "canvas", { v: 2, data: { positions: { t1: { x: 5, y: 6 } } } });
  host.importFrom("/a", guest.exportSince(R, hostSaw), { writer: "guest" });
  guest.importFrom(R, host.exportSince("/a", guestSaw), { writer: "host" });
  for (const [s, r] of [[host, "/a"], [guest, R]] as const) {
    expect(s.getObjects(r)).toEqual([note("from the guest")]);
    expect(s.getView(r, "canvas")).toEqual({ v: 2, data: { positions: { t1: { x: 5, y: 6 } } } });
  }
  // The replica did not mark it: the owner is still the host's person, on both.
  expect(host.ownership("/a")!.owner).toBe(idOf(person));
  expect(guest.ownership(R)).toEqual(host.ownership("/a"));

  // After the host restarts (its history trimmed on disk), a replica that saw everything gets only what is new.
  const seen = guest.version(R);
  const again = restart();
  again.setCore("/a", core("api, renamed"));
  guest.importFrom(R, again.exportSince("/a", seen), { writer: "host" });
  expect(guest.getCore(R)).toEqual(core("api, renamed"));
  // What is not a document's changes is refused and changes nothing.
  expect(() => guest.importFrom(R, new Uint8Array([1, 2, 3]))).toThrow();
  expect(guest.getCore(R)).toEqual(core("api, renamed"));
});

test("files are private, leave no temp files, and stay inside the directory whatever the repo", () => {
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir, person, onWarn: (m) => warnings.push(m) });

  expect(s.getCore("/work/api")).toBeNull();
  expect(warnings).toHaveLength(1);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith(`${API}.loro.corrupt-`));
  expect(aside).toHaveLength(1);
  expect(fs.readFileSync(path.join(dir, aside[0]!)).equals(content)).toBe(true);

  s.setCore("/work/api", core("fresh"));
  expect(restart().getCore("/work/api")).toEqual(core("fresh"));
});

test("an old layout is imported only where the store has nothing, and never replaces what it has", () => {
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir, person, onWarn: (m) => warnings.push(m) });
  s.importLegacy("/a", { core: ["not", "a", "layout"], views: { bogus: { nope: true }, canvas: { v: 1, data: 3 } } });

  expect(warnings).toHaveLength(2);
  const again = restart();
  expect(again.getCore("/a")).toBeNull();
  expect(again.getView("/a", "bogus")).toBeNull();
  expect(again.getView("/a", "canvas")).toEqual({ v: 1, data: 3 });
});

test("undo takes back board edits one write at a time, never the layout or a view; redo makes them again; both are saved", () => {
  const s = new WorkspaceStore({ dir, person });
  // A window's first save of an empty board changes nothing, so it leaves nothing to take back.
  writeBoard(s, "/a", []);
  writeBoard(s, "/a", [note("draft"), list("milk")]);
  writeBoard(s, "/a", [note("drafted"), list("milk", "eggs")]); // at once, and still a step of its own
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
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/a", [note("draft")], { writer: "window:1" });
  writeBoard(s, "/a", [note("draft"), list("milk")], { writer: "window:12", base: [note("draft")] });
  writeBoard(s, "/a", [note("drafted"), list("milk")], { writer: "window:1", base: [note("draft"), list("milk")] });
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
  const s = new WorkspaceStore({ dir, person });
  s.getObjects("/b"); // another open workspace, where the writer never wrote
  writeBoard(s, "/a", [note("draft")], { writer: "window:1" });
  writeBoard(s, "/a", [note("draft"), list("milk")], { writer: "window:2", base: [note("draft")] });
  writeBoard(s, "/c", [note("elsewhere")], { writer: "window:1" });
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
  const s = new WorkspaceStore({ dir, person });
  const canvas = (positions: object) => ({ v: 1, data: { positions } });
  s.setView("/a", "canvas", canvas({ t1: { x: 0, y: 0 }, t2: { x: 100, y: 0 } }), { writer: "window:1" });
  writeBoard(s, "/a", [note("draft")], { writer: "window:1" });
  const view = s.getView("/a", "canvas");
  const board = s.getObjects("/a");
  s.setView("/a", "canvas", canvas({ t1: { x: 0, y: 0 }, t2: { x: 150, y: 50 } }), { writer: "window:2", base: view });
  writeBoard(s, "/a", [note("draft"), list("milk")], { writer: "window:2", base: board });
  s.setView("/a", "canvas", canvas({ t1: { x: 10, y: 10 }, t2: { x: 100, y: 0 } }), { writer: "window:1", base: view });
  writeBoard(s, "/a", [note("drafted")], { writer: "window:1", base: board });
  expect(restart().getView("/a", "canvas")).toEqual(canvas({ t1: { x: 10, y: 10 }, t2: { x: 150, y: 50 } }));
  expect(restart().getObjects("/a")).toEqual([list("milk"), note("drafted")]);
});

test("bad input is refused with a TypeError and stores nothing", () => {
  const s = new WorkspaceStore({ dir, person });
  const bad: Array<() => unknown> = [
    () => s.setCore("", core("x")),
    () => s.setCore(42 as never, core("x")),
    () => s.getCore(undefined as never),
    () => s.setCore("/a", "not a layout"),
    () => s.setView("/a", "canvas", { data: {} } as never),
    () => writeBoard(s, "/a", { n1: note("not a list") }),
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
  const s = new WorkspaceStore({ dir: blockedDir, person, onWarn: (m) => warnings.push(m) });

  s.setCore("/a", core("kept"));
  expect(warnings).toHaveLength(1);
  expect(s.getCore("/a")).toEqual(core("kept"));

  fs.rmSync(blocker);
  s.flush();
  expect(new WorkspaceStore({ dir: blockedDir, person }).getCore("/a")).toEqual(core("kept"));
});

test("each change is told, with who made it and, for the board, which objects it changed; a write that changes nothing is not", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, person, onChange: (c) => told.push(c) });
  s.setCore("/a", core("api"), { writer: "window:1" });
  s.setCore("/a", core("api"), { writer: "window:1" });
  s.setView("/a", "canvas", { v: 1, data: { positions: {} } }, { writer: "window:2" });
  writeBoard(s, "/a", [note("ship it")], { writer: "window:1" });
  s.undo("/a", { writer: "window:2" }); // nothing of its own to take back
  s.undo("/a", { writer: "window:1" });
  expect(s.renameTile("t1", "reviewer", { writer: "control" })).toBe("/a");
  expect(told).toEqual([
    { repo: "/a", part: "core", writer: "window:1" },
    { repo: "/a", part: "view:canvas", writer: "window:2" },
    { repo: "/a", part: "board", writer: "window:1", objects: ["n1"] },
    { repo: "/a", part: "board", writer: "window:1", objects: ["n1"] },
    { repo: "/a", part: "core", writer: "control" },
  ]);
});

test("a tile named by the control plane keeps its name when a window then writes what it read before", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  s.getCore("/b"); // another open workspace, without the tile
  const read = s.getCore("/a");
  expect(s.renameTile("t1", "reviewer")).toBe("/a");
  expect(s.renameTile("nowhere", "x")).toBeNull();
  s.setCore("/a", core("moved"), { base: read });
  expect(restart().getCore("/a")).toEqual({ ...core("moved"), tileNames: { t1: "reviewer" } });
});

test("a tile put to sleep by the control plane stays asleep when a window then writes what it read before, and after a restart; woken, it is not", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  const read = s.getCore("/a");
  expect(s.setSleeping("t1", "/a", { writer: "control" })).toBe("/a");
  expect(s.setSleeping("nowhere", "/a")).toBeNull();
  s.setCore("/a", core("moved"), { base: read });
  const asleep = restart().getCore("/a");
  expect(asleep?.tiles.find((t) => t.id === "t1")?.sleeping).toBe("/a");
  expect(asleep?.frames[0]?.title).toBe("moved");
  s.setSleeping("t1", null, { writer: "control" });
  expect(restart().getCore("/a")?.tiles.find((t) => t.id === "t1")?.sleeping).toBeUndefined();
});

test("a tile closed by the control plane is gone after a restart, and stays closed when a window then writes what it read before", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, person, onChange: (c) => told.push(c) });
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

test("the workspace that holds a tile is the one whose document holds it now: as tiles open and close, and as another replica's changes bring one", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  s.getCore("/b");
  expect([s.workspaceOf("t1"), s.workspaceOf("t2")]).toEqual(["/a", null]);
  s.addTile("/b", { id: "t2", kind: "shell", label: "shell #1" });
  expect(s.workspaceOf("t2")).toBe("/b");
  s.removeTile("t1");
  expect(s.workspaceOf("t1")).toBeNull();
  // Another replica of /b opens t3, and its changes come here.
  const replica = new WorkspaceStore({ dir: path.join(tmp, "replica") });
  replica.importFrom("/b", s.exportSince("/b", null));
  const saw = s.version("/b");
  replica.addTile("/b", { id: "t3", kind: "shell", label: "shell #2" });
  s.importFrom("/b", replica.exportSince("/b", saw));
  expect(s.workspaceOf("t3")).toBe("/b");
});

test("a workspace forgotten is gone, here and after a restart: its tiles are no workspace's, and the others stay", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("hive://a", core("api"));
  s.setCore("/b", { ...core("web"), tiles: [{ id: "t2", kind: "shell" }], frameOf: { t2: "f1" } });
  expect(s.workspaceOf("t1")).toBe("hive://a");
  s.forget("hive://a");
  expect([s.workspaceOf("t1"), s.workspaceOf("t2")]).toEqual([null, "/b"]);
  expect(restart().repos()).toEqual(["/b"]);
  // Asked for again, it starts empty, with no tiles.
  expect(s.getCore("hive://a")).toBeNull();
  expect(s.workspaceOf("t1")).toBeNull();
});

test("a tile the control plane opens is kept, told with its writer, and stays when a window then writes what it read before", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, person, onChange: (c) => told.push(c) });
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

test("what a widget keeps is written by the client that changed it: another's edit made from an older board leaves it", () => {
  const s = new WorkspaceStore({ dir, person });
  const widget = (state: unknown) => ({ id: "w1", kind: "widget", z: 0, widget: "counter", placement: "board", x: 0, y: 0, w: 100, h: 80, state });
  const board = [note("draft"), widget({ n: 1 })];
  writeBoard(s, "/a", board as never);
  writeBoard(s, "/a", [note("draft"), widget({ n: 2 })] as never, { writer: "window:1", base: board });
  // A tab that has not yet read that press edits the note, from the board it holds.
  writeBoard(s, "/a", [note("drafted"), widget({ n: 1 })] as never, { writer: "tab:1", base: board });
  expect(s.getObjects("/a")).toEqual([note("drafted"), widget({ n: 2 })] as never);
  // A client that does change what it keeps still writes it, from whatever board it held.
  writeBoard(s, "/a", [note("drafted"), widget({ n: 3 })] as never, { writer: "tab:1", base: board });
  expect(s.getObjects("/a")).toEqual([note("drafted"), widget({ n: 3 })] as never);
});

test("what a widget keeps is never an undo step: undo takes back the edit before it", () => {
  const s = new WorkspaceStore({ dir, person });
  const widget = (fields: Record<string, unknown>) => ({ id: "w1", kind: "widget", z: 0, widget: "counter", ...fields });
  writeBoard(s, "/a", [widget({})]);
  writeBoard(s, "/a", [widget({ z: 5 })]);
  writeBoard(s, "/a", [widget({ z: 5, state: { n: 1 } })]);
  writeBoard(s, "/a", [widget({ z: 5, state: { n: 2 } })]);
  expect(s.undo("/a")).toBe(true);
  expect(s.getObjects("/a")).toEqual([widget({ z: 0, state: { n: 2 } })] as never);
});

test("a replica taking another's changes is told only the parts they changed", () => {
  const host = new WorkspaceStore({ dir, person });
  const told: WorkspaceChange["part"][] = [];
  const replica = new WorkspaceStore({ dir: path.join(tmp, "replica"), onChange: (c) => told.push(c.part) });
  host.setCore("/a", core("api"));
  host.setView("/a", "canvas", { v: 2, data: { positions: {} } });
  host.setView("/a", "windows", { v: 1, data: { tab: "t1" } });
  writeBoard(host, "/a", [note("ship it")]);
  replica.importFrom("/a", host.exportSince("/a", null));
  const after = (edit: () => void): WorkspaceChange["part"][] => {
    const seen = host.version("/a");
    edit();
    told.length = 0;
    replica.importFrom("/a", host.exportSince("/a", seen));
    return [...told].sort();
  };
  expect(after(() => writeBoard(host, "/a", [note("ship it now")]))).toEqual(["board"]);
  expect(after(() => host.renameTile("t1", "reviewer"))).toEqual(["core"]);
  expect(after(() => host.setView("/a", "windows", { v: 1, data: { tab: "t2" } }))).toEqual(["view:windows"]);
  expect(after(() => host.setView("/a", "board", { v: 1, data: {} }))).toEqual(["view:board"]);
  expect(after(() => { host.setCore("/a", core("renamed")); writeBoard(host, "/a", []); })).toEqual(["board", "core"]);
});

test("a replica taking a workspace whole from a host restarted from disk is told every part", () => {
  const first = new WorkspaceStore({ dir, person });
  first.setCore("/a", core("api"));
  first.setView("/a", "canvas", { v: 2, data: { positions: {} } });
  writeBoard(first, "/a", [note("ship it")]);
  first.flush();
  const host = restart();
  const told: WorkspaceChange["part"][] = [];
  const replica = new WorkspaceStore({ dir: path.join(tmp, "replica"), onChange: (c) => told.push(c.part) });
  replica.importFrom("/a", host.exportSince("/a", null));
  expect(told.sort()).toEqual(["board", "core", "view:canvas"]);
  expect(replica.getCore("/a")!.frames.map((f) => f.title)).toEqual(core("api").frames.map((f) => f.title));
});

/** `n` notes in the store's order (by id), the second with `typed` added. */
const notes = (n: number, typed = "") => Array.from({ length: n }, (_, i) => ({ ...note(`note ${i}${i === 1 ? typed : ""}`), id: `n${String(i).padStart(4, "0")}` }));
const fileOf = (name: string) => path.join(dir, name);

test("a change to a big board adds what it changed to the disk, leaves the snapshot as it was, and is there after a restart", () => {
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/work/api", notes(800));
  const snapshot = fs.readFileSync(fileOf(`${API}.loro`));
  writeBoard(s, "/work/api", notes(800, "!"), { base: notes(800) });
  writeBoard(s, "/work/api", notes(800, "!?"), { base: notes(800, "!") });

  expect(fs.readFileSync(fileOf(`${API}.loro`)).equals(snapshot)).toBe(true);
  expect(fs.statSync(fileOf(`${API}.loro.updates`)).size).toBeLessThan(1024);
  expect(snapshot.length).toBeGreaterThan(30 * 1024);
  expect(restart().getObjects("/work/api")).toEqual(notes(800, "!?"));
});

test("a crash that cut the last change short on disk loses that change alone, and the next change after a restart is kept", () => {
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/work/api", notes(3));
  writeBoard(s, "/work/api", notes(3, " one"), { base: notes(3) });
  writeBoard(s, "/work/api", notes(3, " one two"), { base: notes(3, " one") });
  const updates = fileOf(`${API}.loro.updates`);
  fs.truncateSync(updates, fs.statSync(updates).size - 3);

  const again = restart();
  expect(again.getObjects("/work/api")).toEqual(notes(3, " one"));
  writeBoard(again, "/work/api", notes(3, " one three"), { base: notes(3, " one") });
  expect(restart().getObjects("/work/api")).toEqual(notes(3, " one three"));
});

test("a change on disk that does not load is set aside and reported, the changes before it are kept, and the next write is whole", () => {
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/work/api", notes(3));
  writeBoard(s, "/work/api", notes(3, " one"), { base: notes(3) });
  writeBoard(s, "/work/api", notes(3, " one two"), { base: notes(3, " one") });
  const updates = fileOf(`${API}.loro.updates`);
  const bytes = fs.readFileSync(updates);
  const second = 4 + bytes.readUInt32BE(0);
  bytes.fill(0xff, second + 4);
  fs.writeFileSync(updates, bytes);

  const warnings: string[] = [];
  const again = new WorkspaceStore({ dir, person, onWarn: (m) => warnings.push(m) });
  expect(again.getObjects("/work/api")).toEqual(notes(3, " one"));
  expect(warnings).toHaveLength(1);
  const aside = fs.readdirSync(dir).filter((f) => f.startsWith(`${API}.loro.updates.corrupt-`));
  expect(aside.map((f) => fs.readFileSync(path.join(dir, f)).equals(bytes))).toEqual([true]);

  writeBoard(again, "/work/api", notes(3, " one three"), { base: notes(3, " one") });
  expect(fs.existsSync(updates)).toBe(false);
  expect(restart().getObjects("/work/api")).toEqual(notes(3, " one three"));
});

test("changes on disk past the snapshot's size are folded into a new snapshot once the workspace is quiet, and every one is there after a restart", async () => {
  const s = new WorkspaceStore({ dir, person });
  let board = notes(1);
  writeBoard(s, "/work/api", board);
  const updates = fileOf(`${API}.loro.updates`);
  for (let i = 1; i <= 300; i++) {
    const added = { ...note(`${i} `.repeat(250)), id: `n${String(i).padStart(4, "0")}` };
    writeBoard(s, "/work/api", [...board, added], { base: board });
    board = [...board, added];
  }
  expect(fs.statSync(updates).size).toBeGreaterThan(256 * 1024);

  await new Promise((done) => setTimeout(done, 2500));
  expect(fs.existsSync(updates)).toBe(false);
  expect(restart().getObjects("/work/api")).toEqual(board);
}, 30_000);

test("updates on disk far past the snapshot's size are folded at once, however busy the workspace", () => {
  const s = new WorkspaceStore({ dir, person });
  const kept = (i: number) => [{ ...note("a widget that keeps a lot"), id: "w1", state: { log: `${i} `.repeat(3000).slice(0, 12000) } }];
  writeBoard(s, "/work/api", kept(0));
  const updates = fileOf(`${API}.loro.updates`);
  let largest = 0;
  for (let i = 1; i <= 160; i++) {
    writeBoard(s, "/work/api", kept(i));
    largest = Math.max(largest, fs.existsSync(updates) ? fs.statSync(updates).size : 0);
  }
  expect(largest).toBeGreaterThan(4 * 256 * 1024 - 64 * 1024);
  expect(largest).toBeLessThan(4 * 256 * 1024 + 64 * 1024);
  expect(restart().getObjects("/work/api")).toEqual(kept(160));
});

test("a board edit writes only the objects it names, each merged with what others changed in it since its writer read it", () => {
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/a", notes(3));
  const read = s.getObjects("/a");
  // Another window, since: retypes the first note and takes the third away.
  writeBoard(s, "/a", [{ ...read[0]!, text: "theirs" }, read[1]!], { writer: "window:2" });
  // This one, from what it read: moves the first and retypes the second. The third, taken away, stays away.
  s.editObjects("/a", {
    objects: { n0000: { ...read[0]!, x: 99 }, n0001: { ...read[1]!, text: "mine" } },
    base: { n0000: read[0]!, n0001: read[1]! },
  }, { writer: "window:1" });
  expect(s.getObjects("/a")).toEqual([{ ...read[0]!, text: "theirs", x: 99 }, { ...read[1]!, text: "mine" }]);
  expect(s.getObjectsWithIds("/a", ["n0001", "n0002"])).toEqual({ n0001: { ...read[1]!, text: "mine" }, n0002: null });
});

test("changes taken from another copy are told with the objects they changed", () => {
  const told: WorkspaceChange[] = [];
  const s = new WorkspaceStore({ dir, person });
  writeBoard(s, "/a", notes(3));
  const copy = new WorkspaceStore({ dir: path.join(dir, "copy"), onChange: (c) => told.push(c) });
  copy.importFrom("/a", s.exportSince("/a", null));
  const seen = s.version("/a");
  writeBoard(s, "/a", notes(3).filter((o) => o.id !== "n0002").map((o) => (o.id === "n0000" ? { ...o, text: "retyped" } : o)));
  told.length = 0;
  copy.importFrom("/a", s.exportSince("/a", seen), { writer: "peer" });
  expect(told).toEqual([{ repo: "/a", part: "board", writer: "peer", objects: ["n0000", "n0002"] }]);
});

/** A guest's change to `repo`: its copy of the host's document, changed by `edit`, as updates. */
function guestChange(s: WorkspaceStore, repo: string, edit: (copy: LoroDoc) => void): Uint8Array {
  const copy = new LoroDoc();
  copy.import(s.exportSince(repo, null));
  const seen = copy.oplogVersion();
  edit(copy);
  copy.commit();
  return copy.export({ mode: "update", from: seen });
}
const asEditor = (before: unknown, after: unknown) => refusedEdit(before as never, after as never, "edit");

test("a guest's change to whose the workspace is is refused and undone at once, and its next change, built on it, is taken", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  const owner = s.ownership("/a");
  const copy = new LoroDoc();
  copy.import(s.exportSince("/a", null));
  const start = copy.oplogVersion();
  copy.getMap("meta").set("owner", "someone else");
  copy.commit();
  const claim = copy.export({ mode: "update", from: start });
  const claimed = copy.oplogVersion();
  const read = readCore(copy)!;
  writeCore(copy, { ...read, tileNames: { t1: "build" } }, read);
  copy.commit();
  const rename = copy.export({ mode: "update", from: claimed });

  expect(() => s.importFrom("/a", claim, { writer: "peer" }, asEditor)).toThrow(RefusedImport);
  expect(s.ownership("/a")).toEqual(owner);
  s.importFrom("/a", rename, { writer: "peer" }, asEditor);
  expect(s.getCore("/a")!.tileNames).toEqual({ t1: "build" });
  expect(s.ownership("/a")).toEqual(owner);
});

test("after a guest's change is refused, its next one is checked against the workspace as it is, not with the refused one in it", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  /** A guest's change to the core layout, made from `copy` (the host's document as it read it). */
  const changing = (copy: LoroDoc, name: string, change: (core: CoreLayout) => CoreLayout) => {
    const other = new WorkspaceStore({ dir: path.join(dir, name) });
    other.importFrom("/g", copy.export({ mode: "snapshot" }));
    const read = other.getCore("/g")!;
    const seen = other.version("/g");
    other.setCore("/g", change(read), { base: read });
    return other.exportSince("/g", seen);
  };
  const read = new LoroDoc();
  read.import(s.exportSince("/a", null));
  const shell = changing(read, "shell", (c) => ({ ...c, tiles: [...c.tiles, { id: "t9", kind: "shell", label: "sh", cmd: "/bin/sh" }] }));
  expect(() => s.importFrom("/a", shell, { writer: "peer" }, asEditor)).toThrow(RefusedImport);
  s.importFrom("/a", changing(read, "named", (c) => ({ ...c, tileNames: { t1: "build" } })), { writer: "peer" }, asEditor);
  expect(s.getCore("/a")).toMatchObject({ tiles: [{ id: "t1" }], tileNames: { t1: "build" } });
});

test("a guest's change made after the host's own is checked with the host's in it", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  const named = guestChange(s, "/a", (copy) => copy.getMap("views").set("canvas", 1));
  s.importFrom("/a", named, { writer: "peer" }, asEditor);
  // The host's own window, since: a second frame. The guest, having it, says where it runs.
  const read = s.getCore("/a")!;
  s.setCore("/a", { ...read, frames: [...read.frames, { id: "f2", title: "web" }] }, { base: read });
  const other = new WorkspaceStore({ dir: path.join(dir, "guest") });
  other.importFrom("/g", s.exportSince("/a", null));
  const theirs = other.getCore("/g")!;
  const seen = other.version("/g");
  other.setCore("/g", { ...theirs, frames: theirs.frames.map((f) => (f.id === "f2" ? { ...f, workspacePath: "/" } : f)) }, { base: theirs });
  expect(() => s.importFrom("/a", other.exportSince("/g", seen), { writer: "peer" }, asEditor)).toThrow(/where frame f2 runs is the owner's/);
  expect(s.getCore("/a")!.frames.find((f) => f.id === "f2")).toEqual({ id: "f2", title: "web" });
});


test("a guest's change that waits on one not sent yet is checked when it can apply, even after a refusal in between", () => {
  const s = new WorkspaceStore({ dir, person });
  s.setCore("/a", core("api"));
  const other = new WorkspaceStore({ dir: path.join(dir, "guest") });
  other.importFrom("/g", s.exportSince("/a", null));
  const start = other.version("/g");
  const read = other.getCore("/g")!;
  other.setCore("/g", { ...read, tileNames: { t1: "build" } }, { base: read });
  const named = other.version("/g");
  const first = other.exportSince("/g", start);
  const withName = other.getCore("/g")!;
  other.setCore("/g", { ...withName, tiles: [...withName.tiles, { id: "t9", kind: "shell", label: "sh", cmd: "/bin/sh" }] }, { base: withName });
  const shell = other.exportSince("/g", named);
  // The shell first: it waits on the rename. Then a change that is refused. Then the rename.
  s.importFrom("/a", shell, { writer: "peer" }, asEditor);
  const placing = new WorkspaceStore({ dir: path.join(dir, "placing") });
  placing.importFrom("/g", s.exportSince("/a", null));
  const seen = placing.version("/g");
  const at = placing.getCore("/g")!;
  placing.setCore("/g", { ...at, frames: [{ ...at.frames[0]!, workspacePath: "/" }] }, { base: at });
  expect(() => s.importFrom("/a", placing.exportSince("/g", seen), { writer: "peer" }, asEditor)).toThrow(RefusedImport);
  try { s.importFrom("/a", first, { writer: "peer" }, asEditor); } catch (e) { expect(e).toBeInstanceOf(RefusedImport); }
  expect(s.getCore("/a")!.tiles.map((t) => t.id)).toEqual(["t1"]);
});
