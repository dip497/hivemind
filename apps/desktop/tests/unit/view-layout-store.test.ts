// Per-view versioned layout blobs, with no bridge: localStorage is where they
// live, and a tiny in-memory shim stands in for it. Moving them into main's
// store is workspace-store-client.test.ts.
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

const { loadViewLayout, saveViewLayout } = await import("../../src/renderer/src/workspace/view-layout-store.ts");
const { CANVAS_LAYOUT } = await import("../../src/renderer/src/workspace/views/canvas-layout.ts");

beforeEach(() => store.clear());

type Demo = { a: number; b?: string };
const DEMO = {
  viewId: "demo", version: 2,
  initial: (): Demo => ({ a: 0 }),
};

test("save → load round-trips per view and per repo; they never collide", () => {
  const OTHER = { ...DEMO, viewId: "other" };
  saveViewLayout(DEMO, "/r", { a: 7 });
  saveViewLayout(OTHER, "/r", { a: 8 });
  saveViewLayout(DEMO, "/s", { a: 9 });
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 7 });
  assert.deepEqual(loadViewLayout(OTHER, "/r"), { a: 8 });
  assert.deepEqual(loadViewLayout(DEMO, "/s"), { a: 9 });
});

test("no repo → initial, never touches storage", () => {
  saveViewLayout(DEMO, null, { a: 9 });
  assert.equal(store.size, 0);
  assert.deepEqual(loadViewLayout(DEMO, null), { a: 0 });
});

test("a blob at another version, or corrupt, starts fresh", () => {
  saveViewLayout({ ...DEMO, version: 1 }, "/r", { a: 5 });
  assert.deepEqual(loadViewLayout(DEMO, "/r"), { a: 0 });
  assert.equal(store.size, 1);
  for (const key of store.keys()) store.set(key, "{not json");
  assert.deepEqual(loadViewLayout({ ...DEMO, version: 1 }, "/r"), { a: 0 });
});


test("canvas layout: a fresh repo (no blobs at all) starts empty", () => {
  assert.deepEqual(loadViewLayout(CANVAS_LAYOUT, "/fresh"), { positions: {}, sizes: {}, viewport: undefined });
});

