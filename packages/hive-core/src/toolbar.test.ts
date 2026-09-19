import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOLBAR_ACTIONS, DEFAULT_TOOLBAR_ORDER, isToolbarActionId, resolveToolbar, toolbarAction,
  type ToolbarActionId, type ToolbarPreferences,
} from "./toolbar.js";

describe("toolbar catalog", () => {
  test("the builtin actions are ordered, labelled and hinted", () => {
    expect(BUILTIN_TOOLBAR_ACTIONS.map((a) => [a.id, a.label, a.hint])).toEqual([
      ["terminal", "Terminal", "1"],
      ["agent", "Agent", "2"],
      ["explorer", "Explorer", "3"],
      ["diff", "Diff", "4"],
      ["issues", "Issues", "5"],
      ["frame", "Frame", "6"],
      ["browser", "Browser", "7"],
      ["theme", "Theme", "8"],
    ]);
    expect(DEFAULT_TOOLBAR_ORDER).toEqual(BUILTIN_TOOLBAR_ACTIONS.map((a) => a.id));
    expect(new Set(DEFAULT_TOOLBAR_ORDER).size).toBe(DEFAULT_TOOLBAR_ORDER.length);
  });

  test("id guard + lookup", () => {
    expect(isToolbarActionId("browser")).toBe(true);
    for (const junk of ["Browser", "browse", "", null, 7, {}]) expect(isToolbarActionId(junk)).toBe(false);
    expect(toolbarAction("theme")).toEqual({ id: "theme", label: "Theme", hint: "8" });
  });
});

describe("resolveToolbar", () => {
  test("it returns the metadata array itself — `resolveToolbar(p).map(...)`", () => {
    expect(resolveToolbar({ actions: ["agent"] }).map((a) => a.label)).toEqual(["Agent"]);
    expect(Array.isArray(resolveToolbar())).toBe(true);
  });

  test("no preferences (or no `actions`) is the catalog in default order", () => {
    expect(resolveToolbar()).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    expect(resolveToolbar(undefined).map((a) => a.id)).toEqual([...DEFAULT_TOOLBAR_ORDER]);
    expect(resolveToolbar(null)).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    expect(resolveToolbar({})).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    expect(resolveToolbar({ labels: false })).toEqual(BUILTIN_TOOLBAR_ACTIONS);
    // The common case hands back the catalog itself: no per-render allocation.
    expect(resolveToolbar({})).toBe(BUILTIN_TOOLBAR_ACTIONS);
  });

  test("an EMPTY list is a deliberate empty toolbar, not a missing preference", () => {
    expect(resolveToolbar({ actions: [] })).toEqual([]);
  });

  test("a list is honoured in its own order, deduped, unknowns dropped", () => {
    const r = resolveToolbar({ actions: ["theme", "terminal", "theme"] });
    expect(r.map((a) => a.id)).toEqual(["theme", "terminal"]);
    // A hand-edited file cannot inject an action that does not exist.
    expect(resolveToolbar({ actions: ["agent", "ghost", "diff"] as never }).map((a) => a.id))
      .toEqual(["agent", "diff"]);
    // Resolved entries are the catalog's own frozen metadata.
    expect(r[0]).toBe(toolbarAction("theme")!);
  });

  test("an explicit list of ONLY unknown ids resolves to empty, never to the defaults", () => {
    // The user did express a preference; restoring eight buttons would ignore it.
    expect(resolveToolbar({ actions: ["ghost"] as never })).toEqual([]);
    expect(resolveToolbar({ actions: ["ghost", "Terminal", ""] as never })).toEqual([]);
  });

  test("`labels` is a render flag on the preferences, not part of the result", () => {
    const prefs = { actions: ["agent"] as ToolbarActionId[], labels: true };
    expect(resolveToolbar(prefs).map((a) => a.id)).toEqual(["agent"]); // unaffected by labels
    // The host default is ICON-ONLY: absent (or explicitly false) means no
    // labels, so adding this setting changes nothing for existing users.
    expect(({} as ToolbarPreferences).labels ?? false).toBe(false);
    expect(({ labels: false } as ToolbarPreferences).labels ?? false).toBe(false);
    expect(prefs.labels ?? false).toBe(true); // only an explicit true turns them on
  });

  test("it never grants anything: resolution is pure metadata", () => {
    const a = resolveToolbar({ actions: ["browser"] });
    const b = resolveToolbar({ actions: ["browser"] });
    expect(a).toEqual(b);
    expect(a.map((x) => x.id)).toEqual(["browser"]);
    // Listing `browser` says nothing about whether the Browser tool is enabled —
    // that is tool-plugins' decision, and this module has no opinion.
    expect(Object.keys(a[0]!)).toEqual(["id", "label", "hint"]);
  });
});
