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
    workspaceSetViewSync: (repo: string, viewId: string, layout: ViewLayout) => store.setView(repo, viewId, layout),
    workspaceImportSync: (repo: string, legacy: LegacyLayout) => store.importLegacy(repo, legacy),
    workspaceObjectsSync: (repo: string) => store.getObjects(repo),
    workspaceSetObjectsSync: (repo: string, objects: unknown) => store.setObjects(repo, objects),
    workspaceUndoSync: (repo: string) => store.undo(repo),
    workspaceRedoSync: (repo: string) => store.redo(repo),
    onWorkspaceChanged: () => () => {}, // no other writer here
  },
};

const { loadLayout, reloadLayout, saveLayout } = await import("../../src/renderer/src/canvas-persistence.ts");
const { loadViewLayout, saveViewLayout } = await import("../../src/renderer/src/workspace/view-layout-store.ts");

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
