// Per-view versioned layout blobs + the two built-in specs' one-time imports
// from the pre-plugin storage (canvas geometry inline in the core blob; the
// windows minimized-tab array). A tiny in-memory localStorage shim stands in
// for the browser store.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const { loadViewLayout, saveViewLayout, VIEW_LAYOUT_KEY } = await import("../../src/renderer/src/workspace/view-layout-store.ts");
const { CANVAS_LAYOUT, loadCanvasLayout } = await import("../../src/renderer/src/workspace/views/canvas-layout.ts");
const { WINDOWS_LAYOUT } = await import("../../src/renderer/src/workspace/views/windows-layout.ts");
const { LAYOUT_KEY, saveLayout } = await import("../../src/renderer/src/canvas-persistence.ts");
const { MINIMIZED_KEY } = await import("../../src/renderer/src/windows-view-state.ts");

beforeEach(() => store.clear());

type Demo = { a: number; b?: string };
const DEMO = {
  viewId: "demo", version: 2,
  initial: (): Demo => ({ a: 0 }),
  migrate: (data: unknown, from: number | null): Demo | null => {
    if (from === 1 && data && typeof data === "object") return { a: (data as { n: number }).n, b: "migrated" };
    return null;
  },
};

test("save → load round-trips under a per-view, per-repo key wrapped in {v, data}", () => {
  saveViewLayout(DEMO, "/r", { a: 7 });
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 7 });
  assert.deepEqual(JSON.parse(store.get(VIEW_LAYOUT_KEY("demo", "/r"))!), { v: 2, data: { a: 7 } });
  // Distinct views / repos never collide.
  assert.notEqual(VIEW_LAYOUT_KEY("demo", "/r"), VIEW_LAYOUT_KEY("other", "/r"));
  assert.notEqual(VIEW_LAYOUT_KEY("demo", "/r"), VIEW_LAYOUT_KEY("demo", "/s"));
});

test("no repo → initial, never touches storage", () => {
  saveViewLayout(DEMO, null, { a: 9 });
  assert.equal(store.size, 0);
  assert.deepEqual(loadViewLayout(DEMO, null), { a: 0 });
});

test("an older version is handed to migrate; unmigratable / corrupt → initial", () => {
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), JSON.stringify({ v: 1, data: { n: 5 } }));
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 5, b: "migrated" });
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), JSON.stringify({ v: 0, data: {} }));
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 0 });
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), "{not json");
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 0 });
  // A throwing migrate is treated as "start fresh", never a crash.
  const throwing = { ...DEMO, migrate: () => { throw new Error("boom"); } };
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), JSON.stringify({ v: 1, data: { n: 5 } }));
  assert.deepEqual(loadViewLayout(throwing, "/r"), { a: 0 });
});

test("canvas layout: first load imports geometry from a pre-v2 core blob, then owns it", () => {
  const repo = "/tmp/repo";
  store.set(LAYOUT_KEY(repo), JSON.stringify({
    frames: [], tiles: [{ id: "a", kind: "shell", label: "shell" }],
    positions: { a: { x: 8, y: 16 } }, sizes: { a: { width: 700, height: 480 } }, viewport: { x: 1, y: 2, zoom: 1.25 },
  }));
  const first = loadViewLayout(CANVAS_LAYOUT, repo);
  assert.deepEqual(first, { positions: { a: { x: 8, y: 16 } }, sizes: { a: { width: 700, height: 480 } }, viewport: { x: 1, y: 2, zoom: 1.25 } });
  // Once the canvas store has written, the core blob is no longer consulted —
  // even after the core blob is rewritten at v2 without geometry.
  saveViewLayout(CANVAS_LAYOUT, repo, { ...first, positions: { a: { x: 80, y: 160 } } });
  saveLayout(repo, { frames: [], tileNames: {}, tiles: [], editorTabs: {}, frameOf: {} });
  assert.deepEqual(loadViewLayout(CANVAS_LAYOUT, repo).positions, { a: { x: 80, y: 160 } });
});

test("canvas layout: a core blob left at v1 by an older build is authoritative over the canvas blob", () => {
  const repo = "/tmp/repo-roundtrip";
  // Dev build wrote the canvas blob…
  saveViewLayout(CANVAS_LAYOUT, repo, { positions: { a: { x: 1, y: 1 } }, sizes: {}, viewport: undefined });
  // …then a v1.16.0 build rewrote the core blob (no `version`) with a newer arrangement.
  store.set(LAYOUT_KEY(repo), JSON.stringify({ frames: [], tiles: [], positions: { a: { x: 500, y: 600 } }, sizes: {} }));
  assert.deepEqual(loadCanvasLayout(repo).positions, { a: { x: 500, y: 600 } });
  // Once the core blob is v2 again, the canvas blob is the source.
  saveLayout(repo, { frames: [], tileNames: {}, tiles: [], editorTabs: {}, frameOf: {} });
  assert.deepEqual(loadCanvasLayout(repo).positions, { a: { x: 1, y: 1 } });
  // A v1 core blob WITHOUT geometry (never saved any) does not override.
  store.set(LAYOUT_KEY(repo), JSON.stringify({ frames: [], tiles: [] }));
  assert.deepEqual(loadCanvasLayout(repo).positions, { a: { x: 1, y: 1 } });
});

test("canvas layout: a fresh repo (no blobs at all) starts empty", () => {
  assert.deepEqual(loadViewLayout(CANVAS_LAYOUT, "/fresh"), { positions: {}, sizes: {}, viewport: undefined });
});

test("windows layout: first load imports the legacy minimized-tab array", () => {
  const repo = "/tmp/w";
  store.set(MINIMIZED_KEY(repo), JSON.stringify(["t1", "t2"]));
  assert.deepEqual(loadViewLayout(WINDOWS_LAYOUT, repo), { minimized: ["t1", "t2"], activeTabId: null });
  saveViewLayout(WINDOWS_LAYOUT, repo, { minimized: ["t2"], activeTabId: "t9" });
  assert.deepEqual(loadViewLayout(WINDOWS_LAYOUT, repo), { minimized: ["t2"], activeTabId: "t9" });
  assert.deepEqual(loadViewLayout(WINDOWS_LAYOUT, "/none"), { minimized: [], activeTabId: null });
});
