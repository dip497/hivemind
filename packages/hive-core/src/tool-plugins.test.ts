import { describe, expect, test } from "bun:test";
import {
  BROWSER_PLUGIN_ID, BROWSER_TOOL, BROWSER_TOOL_ID, BUNDLED_TOOL_PLUGINS,
  bundledToolRegistry, bundledTools, tileKindAvailability, toolIdForTileKind,
} from "./tool-plugins.js";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings-schema.js";
import { createToolRegistry } from "./tool-registry.js";

const prefs = (enabledPlugins: string[], disabledTools: string[] = []) => ({ enabledPlugins, disabledTools });
/** true = offerable; a legacy (unmanaged) kind answers `null`. */
const allowed = (kind: string, tools: { enabledPlugins: string[]; disabledTools: string[] }) =>
  tileKindAvailability(kind, tools)?.available ?? true;

describe("bundled tool plugins", () => {
  test("the web plugin contributes exactly the Browser tool", () => {
    expect(BUNDLED_TOOL_PLUGINS.map((p) => p.id)).toEqual([BROWSER_PLUGIN_ID]);
    expect(BROWSER_PLUGIN_ID).toBe("hivemind/web");
    expect(bundledTools().map((t) => t.id)).toEqual([BROWSER_TOOL_ID]);
    expect(BROWSER_TOOL_ID).toBe("hivemind/web/browser");
    expect(BROWSER_TOOL).toEqual({ toolId: BROWSER_TOOL_ID, tileKind: "browser" });
    expect(toolIdForTileKind("browser")).toBe(BROWSER_TOOL_ID);
    expect(toolIdForTileKind("shell")).toBeNull();
  });

  test("the bundled contributions pass the registry's own validation", () => {
    // createToolRegistry throws on a malformed id/key/label; building it here is
    // the assertion that the bundled metadata is well-formed.
    expect(createToolRegistry(BUNDLED_TOOL_PLUGINS).tools.map((t) => t.id)).toEqual([BROWSER_TOOL_ID]);
    expect(bundledToolRegistry.tools[0]!.label).toBe("Browser");
  });
});

describe("tile-kind availability", () => {
  test("a managed kind needs its plugin enabled — installation alone is not enough", () => {
    expect(tileKindAvailability("browser", prefs([]))).toEqual({ available: false, reason: "plugin-disabled" });
    expect(tileKindAvailability("browser", prefs([BROWSER_PLUGIN_ID]))?.available).toBe(true);
  });

  test("a disabled tool inside an enabled plugin is unavailable", () => {
    expect(tileKindAvailability("browser", prefs([BROWSER_PLUGIN_ID], [BROWSER_TOOL_ID])))
      .toEqual({ available: false, reason: "tool-disabled" });
  });

  test("unmanaged legacy kinds answer null (the caller treats that as always available)", () => {
    for (const kind of ["shell", "editor", "diff", "issues", "claude", "workbench"]) {
      expect(tileKindAvailability(kind, prefs([]))).toBeNull();
      expect(tileKindAvailability(kind, prefs([BROWSER_PLUGIN_ID], [BROWSER_TOOL_ID]))).toBeNull();
      expect(allowed(kind, prefs([]))).toBe(true);
    }
  });

  test("an unknown tool id is never enabled, whatever the preferences claim", () => {
    // A stale/hand-edited enabledPlugins entry cannot conjure a tool: the kind is
    // managed, its tool is not in the registry, so it stays unavailable.
    const managed = new Map([["ghost", "someone/else/ghost"]]);
    expect(tileKindAvailability("ghost", prefs(["someone/else"]), bundledToolRegistry, managed))
      .toEqual({ available: false, reason: "not-installed" });
    expect(bundledToolRegistry.resolve(prefs(["someone/else"])).availability("someone/else/ghost"))
      .toEqual({ available: false, reason: "not-installed" });
  });

  test("it reads the preferences shape settings.json stores", () => {
    const off = mergeSettings(DEFAULT_SETTINGS);
    expect(tileKindAvailability("browser", off.tools)?.available).toBe(false);
    const on = mergeSettings({ ...DEFAULT_SETTINGS, tools: { enabledPlugins: [BROWSER_PLUGIN_ID], disabledTools: [] } });
    expect(tileKindAvailability("browser", on.tools)?.available).toBe(true);
    // The migration constant in settings-schema must stay the same plugin id.
    expect(mergeSettings({ v: 1 }).tools.enabledPlugins).toEqual([BROWSER_PLUGIN_ID]);
  });
});
