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
  nextActiveTab,
} = await import("../../src/renderer/src/windows-view-state.ts");

beforeEach(() => store.clear());

// Validation against the registered plugins is resolveViewId's job (see
// workspace-view.test.ts) — the raw pref stays a plain string so a plugin can
// be added or removed without a storage migration.

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
