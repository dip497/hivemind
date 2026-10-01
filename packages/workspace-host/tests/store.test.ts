// The workspace store through its public API, against a real directory: what it keeps, the file
// format existing installs depend on, what it refuses, and what it does when the disk fails.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/store.ts";
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
const note = (text: string) => ({ id: "n1", kind: "note" as const, x: 10, y: 20, w: 200, h: 160, text });
const list = (...items: string[]) =>
  ({ id: "c1", kind: "checklist" as const, x: 0, y: 200, w: 240, h: 200, text: "today", items: items.map((text, i) => ({ id: `i${i + 1}`, text, done: false })) });
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
  const s = new WorkspaceStore({ dir, person });
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
  s.setObjects("/b", [note("ship it")]);
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
  guest.setObjects(R, [note("from the guest")]);
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
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir, person });
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
  const s = new WorkspaceStore({ dir: blockedDir, person, onWarn: (m) => warnings.push(m) });

  s.setCore("/a", core("kept"));
  expect(warnings).toHaveLength(1);
  expect(s.getCore("/a")).toEqual(core("kept"));

  fs.rmSync(blocker);
  s.flush();
  expect(new WorkspaceStore({ dir: blockedDir, person }).getCore("/a")).toEqual(core("kept"));
});

test("each change is told, with who made it; a write that changes nothing is not", () => {
  const told: unknown[] = [];
  const s = new WorkspaceStore({ dir, person, onChange: (c) => told.push(c) });
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
  const s = new WorkspaceStore({ dir, person });
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
