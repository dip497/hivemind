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
const { CANVAS_LAYOUT } = await import("../../src/renderer/src/workspace/views/canvas-layout.ts");

beforeEach(() => store.clear());

type Demo = { a: number; b?: string };
const DEMO = {
  viewId: "demo", version: 2,
  initial: (): Demo => ({ a: 0 }),
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

test("a blob at another version, or corrupt, starts fresh", () => {
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), JSON.stringify({ v: 1, data: { n: 5 } }));
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 0 });
  store.set(VIEW_LAYOUT_KEY("demo", "/r"), "{not json");
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 0 });
});


test("canvas layout: a fresh repo (no blobs at all) starts empty", () => {
  assert.deepEqual(loadViewLayout(CANVAS_LAYOUT, "/fresh"), { positions: {}, sizes: {}, viewport: undefined });
});

