// Windowed-view state — persistence (global viewMode + per-repo minimized tab
// set) + the pure nextActiveTab helper. Unit-testable because they're plain
// module functions; a tiny in-memory localStorage shim stands in for the
// browser store (same pattern as canvas-persistence.test.ts).
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

const {
  loadViewMode, saveViewMode, loadMinimized, saveMinimized, MINIMIZED_KEY, nextActiveTab,
} = await import("../../src/renderer/src/windows-view-state.ts");

beforeEach(() => store.clear());

test("viewMode defaults to canvas, round-trips through storage", () => {
  assert.equal(loadViewMode(), "canvas");
  saveViewMode("windows");
  assert.equal(loadViewMode(), "windows");
  saveViewMode("canvas");
  assert.equal(loadViewMode(), "canvas");
});

test("viewMode ignores garbage → canvas", () => {
  store.set("hivemind:view-mode", "nonsense");
  assert.equal(loadViewMode(), "canvas");
});

test("minimized set is per-repo and round-trips", () => {
  const repoA = "/tmp/a";
  const repoB = "/tmp/b";
  saveMinimized(repoA, new Set(["t1", "t2"]));
  saveMinimized(repoB, new Set(["t9"]));
  assert.deepEqual([...loadMinimized(repoA)].sort(), ["t1", "t2"]);
  assert.deepEqual([...loadMinimized(repoB)], ["t9"]);
  // Distinct keys → no cross-repo leak.
  assert.notEqual(MINIMIZED_KEY(repoA), MINIMIZED_KEY(repoB));
});

test("no-repo minimized set never touches storage", () => {
  saveMinimized(null, new Set(["x"]));
  assert.equal(store.size, 0);
  assert.deepEqual([...loadMinimized(null)], []);
});

test("loadMinimized tolerates malformed json → empty set", () => {
  const repo = "/tmp/bad";
  store.set(MINIMIZED_KEY(repo), "{not json");
  assert.deepEqual([...loadMinimized(repo)], []);
});

test("nextActiveTab keeps a still-visible current tab", () => {
  assert.equal(nextActiveTab("b", ["a", "b", "c"]), "b");
});

test("nextActiveTab falls back to first visible when current is gone", () => {
  // e.g. the active tab was just minimized or closed.
  assert.equal(nextActiveTab("b", ["a", "c"]), "a");
});

test("nextActiveTab → null when nothing is visible", () => {
  assert.equal(nextActiveTab("b", []), null);
  assert.equal(nextActiveTab(null, []), null);
});

test("nextActiveTab picks first when there is no current", () => {
  assert.equal(nextActiveTab(null, ["a", "b"]), "a");
});
