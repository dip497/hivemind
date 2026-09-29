// The window's layouts with main's workspace store behind the bridge: a layout an earlier
// version kept in localStorage comes across once and never over a newer one, and saves go to
// the store, not localStorage. The bridge is a real WorkspaceStore; localStorage is a shim.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore, type LegacyLayout, type ViewLayout } from "@hivemind/workspace-host/store";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-client-"));
const store = new WorkspaceStore({ dir });
const ls = new Map<string, string>();

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() { return ls.size; },
  },
  hive: {
    workspaceCoreSync: (repo: string) => store.getCore(repo),
    workspaceViewSync: (repo: string, viewId: string) => store.getView(repo, viewId),
    workspaceSetCoreSync: (repo: string, core: unknown, base?: unknown) => store.setCore(repo, core, { base }),
    workspaceSetViewSync: (repo: string, viewId: string, layout: ViewLayout, base?: unknown) => store.setView(repo, viewId, layout, { base }),
    workspaceImportSync: (repo: string, legacy: LegacyLayout) => store.importLegacy(repo, legacy),
    workspaceObjectsSync: (repo: string) => store.getObjects(repo),
    workspaceSetObjectsSync: (repo: string, objects: unknown, base?: unknown) => store.setObjects(repo, objects, { base }),
    workspaceUndoSync: (repo: string) => store.undo(repo),
    workspaceRedoSync: (repo: string) => store.redo(repo),
    onWorkspaceChanged: () => () => {}, // no other writer here
    workspaceShown: () => {},
  },
};

const { loadLayout, reloadLayout, saveLayout } = await import("../../src/renderer/src/canvas-persistence.ts");
const { loadViewLayout, saveViewLayout } = await import("../../src/renderer/src/workspace/view-layout-store.ts");
const { CANVAS_CAMERA, CANVAS_LAYOUT, loadCanvasCamera, reloadCanvasLayout } = await import("../../src/renderer/src/workspace/views/canvas-layout.ts");
const { WINDOWS_LAYOUT } = await import("../../src/renderer/src/workspace/views/windows-layout.ts");
const { readBoard, writeBoard } = await import("../../src/renderer/src/workspace/workspace-store-client.ts");
const { reloadBoardObjects } = await import("../../src/renderer/src/board-objects/useBoard.ts");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const frame = (id: string, title: string) => ({ id, x: 0, y: 0, w: 400, h: 300, title, color: "#888", z: 1 });
const titles = (core: unknown) => (core as { frames: Array<{ title: string }> }).frames.map((f) => f.title);
const DEMO = { viewId: "demo", version: 2, initial: () => ({ a: 0 }) };

test("a layout an earlier version kept in localStorage comes across on first read, never over a newer one", () => {
  // What versions before the store wrote, under these exact keys.
  ls.set("hivemind:canvas-layout:/old", JSON.stringify({ frames: [frame("f9", "legacy")], tiles: [{ id: "t9", kind: "shell", label: "sh" }], frameOf: { t9: "f9" } }));
  ls.set("hivemind:view-layout:demo:/old", JSON.stringify({ v: 2, data: { a: 5 } }));
  ls.set("hivemind:canvas-layout:/kept", JSON.stringify({ frames: [frame("f0", "stale")] }));
  store.setCore("/kept", { frames: [frame("f1", "current")] });

  const old = loadLayout("/old");
  assert.deepEqual(old.frames.map((f) => f.title), ["legacy"]);
  assert.deepEqual(old.tiles?.map((t) => t.id), ["t9"]);
  assert.deepEqual(loadViewLayout(DEMO, "/old"), { a: 5 });
  assert.deepEqual(titles(store.getCore("/old")), ["legacy"], "main's store has it now");
  assert.deepEqual(loadLayout("/kept").frames.map((f) => f.title), ["current"]);
});

test("saves go to the store and leave localStorage alone", () => {
  const before = new Map(ls);
  saveLayout("/new", { frames: [frame("f1", "api")], tileNames: {}, tiles: [{ id: "t1", kind: "claude", label: "Claude" }], editorTabs: {}, frameOf: { t1: "f1" } });
  saveViewLayout(DEMO, "/new", { a: 7 });
  assert.deepEqual(new Map(ls), before);
  assert.deepEqual(titles(store.getCore("/new")), ["api"]);
  assert.deepEqual(store.getView("/new", "demo"), { v: 2, data: { a: 7 } });
});

test("a save from what the window last read or wrote keeps what another writer changed since", () => {
  const layout = { frames: [frame("f1", "api")], tileNames: {}, tiles: [{ id: "t7", kind: "claude" as const, label: "Claude" }], editorTabs: {}, frameOf: { t7: "f1" } };
  saveLayout("/shared", layout);
  assert.equal(store.renameTile("t7", "reviewer", { writer: "control" }), "/shared");
  const read = loadLayout("/shared"); // the window reads that name, and another comes after it
  store.renameTile("t7", "lead", { writer: "control" });
  saveLayout("/shared", { ...layout, tileNames: read.tileNames, frames: [frame("f1", "api, moved")] });
  assert.deepEqual(store.getCore("/shared")?.tileNames, { t7: "lead" });
  assert.deepEqual(titles(store.getCore("/shared")), ["api, moved"]);
  // The window names it itself, then the other writer does, then the window saves again.
  saveLayout("/shared", { ...layout, tileNames: { t7: "mine" }, frames: [frame("f1", "api, moved")] });
  store.renameTile("t7", "theirs", { writer: "control" });
  saveLayout("/shared", { ...layout, tileNames: { t7: "mine" }, frames: [frame("f1", "api, moved again")] });
  assert.deepEqual(store.getCore("/shared")?.tileNames, { t7: "theirs" });
});

test("what another writer changed comes in over what the window has not saved, which stays, and is saved from there", () => {
  const tile = (id: string, kind: "claude" | "shell" | "planReview" = "shell") => ({ id, kind, label: id });
  const saved = { frames: [frame("f1", "api")], tileNames: {}, tiles: [tile("b1", "claude"), tile("b2")], editorTabs: {}, frameOf: { b1: "f1", b2: "f1" } };
  saveLayout("/both", { ...saved, frames: [frame("f1", "first")] });
  saveLayout("/both", saved); // the window's base is what it wrote last
  // Since: the control plane names b1 and closes b2, and another window opens b4.
  store.renameTile("b1", "lead", { writer: "control" });
  store.removeTile("b2", { writer: "control" });
  store.setCore("/both", { ...saved, tiles: [...saved.tiles, tile("b4")] }, { base: saved, writer: "window:9" });
  // What the window has, not yet saved: f1 moved, b3 opened, and a plan review, which is never saved.
  const mine = { ...saved, frames: [frame("f1", "api, moved")], tiles: [...saved.tiles, tile("b3"), tile("bp", "planReview")], frameOf: { ...saved.frameOf, b3: "f1" } };

  const stored = reloadLayout("/both");
  assert.deepEqual(stored.closed, ["b2"]);
  const merged = {
    frames: stored.frames(mine.frames),
    tileNames: stored.tileNames(mine.tileNames),
    tiles: stored.tiles(mine.tiles),
    editorTabs: stored.editorTabs(mine.editorTabs),
    frameOf: stored.frameOf(mine.frameOf),
  };
  assert.deepEqual(merged, {
    frames: [frame("f1", "api, moved")],
    tileNames: { b1: "lead" },
    tiles: [tile("b1", "claude"), tile("b3"), tile("bp", "planReview"), tile("b4")],
    editorTabs: {},
    frameOf: { b1: "f1", b3: "f1" },
  });
  // Saved from what it read now: the window's own changes, and the control plane's stay.
  saveLayout("/both", merged);
  store.renameTile("b1", "lead, again", { writer: "control" });
  saveLayout("/both", { ...merged, frames: [frame("f1", "api, moved again")] });
  assert.deepEqual(store.getCore("/both"), {
    frames: [frame("f1", "api, moved again")],
    tiles: [tile("b1", "claude"), tile("b3"), tile("b4")],
    tileNames: { b1: "lead, again" },
    editorTabs: {},
    frameOf: { b1: "f1", b3: "f1" },
  });
});

const at = (x: number, y = 0) => ({ x, y });
const places = (positions: Record<string, { x: number; y: number }>) => ({ positions, sizes: {} });
const note = (id: string, text: string) => ({ id, kind: "note" as const, x: 0, y: 0, w: 200, h: 160, text });

test("the canvas's places and the board are saved from what the window last read or wrote, so another window's change since stays", () => {
  saveViewLayout(CANVAS_LAYOUT, "/views", places({ t1: at(0), t2: at(100) }));
  store.setView("/views", "canvas", { v: 1, data: places({ t1: at(0), t2: at(150, 50) }) }, { base: store.getView("/views", "canvas"), writer: "window:9" });
  saveViewLayout(CANVAS_LAYOUT, "/views", places({ t1: at(10, 10), t2: at(100) }));
  assert.deepEqual(store.getView("/views", "canvas")?.data, places({ t1: at(10, 10), t2: at(150, 50) }));

  writeBoard("/views", [note("n1", "draft")]);
  store.setObjects("/views", [note("n1", "draft"), note("n2", "theirs")], { base: store.getObjects("/views"), writer: "window:9" });
  writeBoard("/views", [note("n1", "drafted")]);
  assert.deepEqual(readBoard("/views"), [note("n1", "drafted"), note("n2", "theirs")]);
});

test("another window's change to the canvas's places comes in over what the window has not saved, which stays", () => {
  saveViewLayout(CANVAS_LAYOUT, "/places", { positions: { t1: at(0), t2: at(100) }, sizes: { t2: { width: 400, height: 300 } } });
  // Since: another window moves t2 and places t3.
  store.setView("/places", "canvas", { v: 1, data: { positions: { t1: at(0), t2: at(150, 50), t3: at(300) }, sizes: { t2: { width: 400, height: 300 } } } }, { base: store.getView("/places", "canvas"), writer: "window:9" });
  // This window, not yet saved: t1 moved and t2 resized.
  const stored = reloadCanvasLayout("/places");
  assert.deepEqual(stored.positions({ t1: at(10, 10), t2: at(100) }), { t1: at(10, 10), t2: at(150, 50), t3: at(300) });
  assert.deepEqual(stored.sizes({ t2: { width: 500, height: 300 } }), { t2: { width: 500, height: 300 } });
});

test("what is one person's own is kept on this device, starting from what the workspace held, and never written to it", () => {
  // What the document held before these were one person's.
  store.setView("/me", "windows", { v: 1, data: { minimized: ["t1"], activeTabId: "t2" } });
  store.setView("/me", "canvas", { v: 1, data: { positions: {}, sizes: {}, viewport: { x: 1, y: 2, zoom: 0.5 } } });
  store.setCore("/me", { frames: [], tiles: [{ id: "t1", kind: "shell", label: "sh", pinned: true, pinAnchor: { sx: 10, sy: 20 }, pinSize: { w: 300, h: 200 } }] });
  const before = { windows: store.getView("/me", "windows"), canvas: store.getView("/me", "canvas") };

  assert.deepEqual(loadViewLayout(WINDOWS_LAYOUT, "/me"), { minimized: ["t1"], activeTabId: "t2" });
  assert.deepEqual(loadCanvasCamera("/me"), { x: 1, y: 2, zoom: 0.5 });
  saveViewLayout(WINDOWS_LAYOUT, "/me", { minimized: [], activeTabId: "t3" });
  saveViewLayout(CANVAS_CAMERA, "/me", { x: 5, y: 5, zoom: 1 });
  assert.deepEqual(loadViewLayout(WINDOWS_LAYOUT, "/me"), { minimized: [], activeTabId: "t3" });
  assert.deepEqual(loadCanvasCamera("/me"), { x: 5, y: 5, zoom: 1 });
  assert.deepEqual({ windows: store.getView("/me", "windows"), canvas: store.getView("/me", "canvas") }, before);
  assert.equal(store.getView("/me", CANVAS_CAMERA.viewId), null);

  // A pin the tile carried is this device's to start from, and the window's next save takes it out of the workspace.
  const read = loadLayout("/me");
  assert.deepEqual(read.pins, { t1: { anchor: { sx: 10, sy: 20 }, size: { w: 300, h: 200 } } });
  assert.deepEqual(read.tiles, [{ id: "t1", kind: "shell", label: "sh" }]);
  saveLayout("/me", { frames: read.frames, tileNames: {}, tiles: read.tiles ?? [], editorTabs: {}, frameOf: {} });
  assert.deepEqual(store.getCore("/me")?.tiles, [{ id: "t1", kind: "shell", label: "sh" }]);
});

test("another window's change to the board comes in over what the window has not saved, which stays", () => {
  writeBoard("/board", [note("n1", "draft"), note("n2", "old")]);
  store.setObjects("/board", [note("n1", "draft"), note("n3", "theirs")], { base: store.getObjects("/board"), writer: "window:9" });
  // This window, not yet saved: n1 retyped. n2, deleted since, stays deleted.
  const merged = reloadBoardObjects("/board", [])([note("n1", "drafted"), note("n2", "old")]);
  assert.deepEqual(merged, [note("n1", "drafted"), note("n3", "theirs")]);
});

test("what the window reads is what its next save is made from", () => {
  writeBoard("/read", [note("n1", "a")]);
  store.setObjects("/read", [note("n1", "a"), note("n2", "b")], { base: store.getObjects("/read"), writer: "window:9" });
  const board = readBoard("/read");
  store.setObjects("/read", [note("n1", "a")], { base: store.getObjects("/read"), writer: "window:9" });
  writeBoard("/read", board);
  assert.deepEqual(readBoard("/read"), [note("n1", "a")], "n2, deleted after this window read it, stays deleted");

  saveViewLayout(CANVAS_LAYOUT, "/read", places({ t1: at(0) }));
  store.setView("/read", "canvas", { v: 1, data: places({ t1: at(0), t2: at(5) }) }, { base: store.getView("/read", "canvas"), writer: "window:9" });
  const view = loadViewLayout(CANVAS_LAYOUT, "/read");
  store.setView("/read", "canvas", { v: 1, data: places({ t1: at(0) }) }, { base: store.getView("/read", "canvas"), writer: "window:9" });
  saveViewLayout(CANVAS_LAYOUT, "/read", view);
  assert.deepEqual(store.getView("/read", "canvas")?.data, places({ t1: at(0) }), "t2, taken off after this window read it, stays off");
});
