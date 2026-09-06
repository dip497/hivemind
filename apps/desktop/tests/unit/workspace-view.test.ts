// The view-plugin registry: registration order, fallback resolution for
// unknown / missing ids (an uninstalled plugin must never brick the app), and
// the ⌘E cycle.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerView, getView, listViews, resolveViewId, nextViewId, FALLBACK_VIEW_ID, _resetViewsForTest,
  type WorkspaceViewPlugin,
} from "../../src/renderer/src/workspace/workspace-view.ts";

const plugin = (id: string): WorkspaceViewPlugin => ({
  id, label: id, hint: "", icon: (() => null) as unknown as WorkspaceViewPlugin["icon"], component: () => null,
});

beforeEach(() => _resetViewsForTest());

test("nothing registered → resolveViewId is null (runtime shows its failure panel)", () => {
  assert.equal(resolveViewId("canvas"), null);
  assert.equal(nextViewId(null), null);
});

test("a known id resolves to itself; an unknown/stale one to the fallback", () => {
  registerView(plugin("canvas"));
  registerView(plugin("windows"));
  assert.equal(resolveViewId("windows"), "windows");
  assert.equal(resolveViewId("mars-base"), FALLBACK_VIEW_ID);
  assert.equal(resolveViewId(null), FALLBACK_VIEW_ID);
  assert.equal(resolveViewId(undefined), FALLBACK_VIEW_ID);
});

test("without the canvas registered, the first registered view is the fallback", () => {
  registerView(plugin("windows"));
  registerView(plugin("solar"));
  assert.equal(resolveViewId("nope"), "windows");
});

test("listViews keeps registration order; nextViewId cycles through it and wraps", () => {
  registerView(plugin("canvas"));
  registerView(plugin("windows"));
  registerView(plugin("solar"));
  assert.deepEqual(listViews().map((v) => v.id), ["canvas", "windows", "solar"]);
  assert.equal(nextViewId("canvas"), "windows");
  assert.equal(nextViewId("solar"), "canvas");
  assert.equal(nextViewId(null), "canvas");
  assert.equal(nextViewId("unknown"), "canvas", "an unknown current id starts the cycle over");
});

test("re-registering an id replaces the plugin in place", () => {
  registerView(plugin("canvas"));
  const v2 = { ...plugin("canvas"), label: "Canvas v2" };
  registerView(v2);
  assert.equal(getView("canvas")?.label, "Canvas v2");
  assert.equal(listViews().length, 1);
});
