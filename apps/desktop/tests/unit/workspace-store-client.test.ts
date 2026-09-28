// The window's layout loaders with main's workspace store behind them: reads and writes go to
// the store, the layout a window kept in localStorage is imported once without overwriting
// anything newer, and nothing is written to localStorage any more. The bridge is a real
// WorkspaceStore; localStorage is a small in-memory shim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "@hivemind/workspace-host/store";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-client-"));
const store = new WorkspaceStore({ dir, flushMs: 0 });
const ls = new Map<string, string>();
let imports = 0;

(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (ls.has(k) ? ls.get(k)! : null),
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() { return ls.size; },
  },
  hive: {
    workspaceCoreSync: (repo: string) => store.getCore(repo),
    workspaceViewSync: (repo: string, viewId: string) => store.getView(repo, viewId),
    workspaceSetCoreSync: (repo: string, core: unknown) => store.setCore(repo, core, "window:1"),
    workspaceSetViewSync: (repo: string, viewId: string, env: { v: number; data: unknown }) => store.setView(repo, viewId, env, "window:1"),
    workspaceImportSync: (repo: string, legacy: { core?: unknown; views?: Record<string, { v: number; data: unknown }> }) => { imports++; return store.importLegacy(repo, legacy); },
  },
};

const { loadLayout, saveLayout, LAYOUT_KEY } = await import("../../src/renderer/src/canvas-persistence.ts");
const { loadViewLayout, saveViewLayout, VIEW_LAYOUT_KEY } = await import("../../src/renderer/src/workspace/view-layout-store.ts");

before(() => ls.clear());
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const frame = (id: string, title: string) => ({ id, x: 0, y: 0, w: 400, h: 300, title, color: "#888", z: 1 });
const snap = (title: string) => ({
  frames: [frame("f1", title)], tileNames: { t1: "api agent" },
  tiles: [{ id: "t1", kind: "claude" as const, label: "Claude" }, { id: "p1", kind: "planReview" as const, label: "Plan" }],
  editorTabs: { e1: ["src/a.ts"] }, frameOf: { t1: "f1" },
});
const DEMO = { viewId: "demo", version: 2, initial: () => ({ a: 0 }) };

test("a window's old localStorage layout is imported on first read", () => {
  ls.set(LAYOUT_KEY("/old"), JSON.stringify({ frames: [frame("f9", "legacy")], tiles: [{ id: "t9", kind: "shell", label: "sh" }], frameOf: { t9: "f9" } }));
  ls.set(VIEW_LAYOUT_KEY("demo", "/old"), JSON.stringify({ v: 2, data: { a: 5 } }));
  ls.set(VIEW_LAYOUT_KEY("canvas", "/old"), JSON.stringify({ v: 1, data: { positions: {} } }));
  ls.set(VIEW_LAYOUT_KEY("demo", "/other"), JSON.stringify({ v: 2, data: { a: 99 } }));
  const layout = loadLayout("/old");
  assert.deepEqual(layout.frames.map((f) => f.title), ["legacy"]);
  assert.deepEqual(layout.tiles?.map((t) => t.id), ["t9"]);
  assert.deepEqual(loadViewLayout(DEMO, "/old"), { a: 5 });
  assert.deepEqual(Object.keys(store.load("/old").views).sort(), ["canvas", "demo"], "only this repo's views");
  assert.equal(store.getView("/other", "demo"), null);
});

test("saves go to the store, not localStorage; plan reviews are still never saved", () => {
  const before = new Map(ls);
  saveLayout("/new", snap("api"));
  saveViewLayout(DEMO, "/new", { a: 7 });
  assert.deepEqual(new Map(ls), before, "localStorage untouched");
  const stored = store.getCore("/new") as ReturnType<typeof snap>;
  assert.deepEqual(stored.tiles.map((t) => t.id), ["t1"]);
  assert.deepEqual(loadLayout("/new").frames.map((f) => f.title), ["api"]);
  assert.deepEqual(loadViewLayout(DEMO, "/new"), { a: 7 });
});

test("what the store has wins over an older localStorage copy", () => {
  saveLayout("/both", snap("current"));
  ls.set(LAYOUT_KEY("/both"), JSON.stringify({ frames: [frame("f0", "stale")] }));
  assert.deepEqual(loadLayout("/both").frames.map((f) => f.title), ["current"]);
});

test("the import is offered once per repo per window", () => {
  const n = imports;
  loadLayout("/once");
  ls.set(LAYOUT_KEY("/once"), JSON.stringify({ frames: [frame("f1", "late")] }));
  loadLayout("/once");
  loadViewLayout(DEMO, "/once");
  assert.equal(imports, n, "nothing to offer the first time, and no second offer");
  assert.deepEqual(loadLayout("/once").frames, []);
});

test("a stored view at another version starts fresh; no repo touches nothing", () => {
  saveViewLayout({ ...DEMO, version: 1 }, "/ver", { a: 3 });
  assert.deepEqual(loadViewLayout(DEMO, "/ver"), { a: 0 });
  saveLayout(null, snap("x"));
  saveViewLayout(DEMO, null, { a: 1 });
  assert.deepEqual(loadLayout(null), { frames: [], tileNames: {} });
  assert.deepEqual(loadViewLayout(DEMO, null), { a: 0 });
});

test("the store's file on disk holds what the window saved", () => {
  store.flush();
  const files = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { repo: string });
  assert.ok(files.some((f) => f.repo === "/new"));
});
