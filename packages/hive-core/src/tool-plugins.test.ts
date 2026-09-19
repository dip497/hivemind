import { describe, expect, test } from "bun:test";
import {
  availableCommands, BROWSER_PLUGIN_ID, BROWSER_TOOL, BROWSER_TOOL_ID, BUNDLED_TOOL_PLUGINS,
  bundledToolRegistry, bundledTools, CODE_PLUGIN_ID, ISSUES_PLUGIN_ID, tileKindAvailability, toolIdForTileKind,
} from "./tool-plugins.js";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings-schema.js";
import { createToolRegistry } from "./tool-registry.js";

const prefs = (enabledPlugins: string[], disabledTools: string[] = []) => ({ enabledPlugins, disabledTools });
/** true = offerable; a legacy (unmanaged) kind answers `null`. */
const allowed = (kind: string, tools: { enabledPlugins: string[]; disabledTools: string[] }) =>
  tileKindAvailability(kind, tools)?.available ?? true;

describe("bundled tool plugins", () => {
  test("the built-in tiles are plugins too — only the web plugin is opt-in", () => {
    expect(BUNDLED_TOOL_PLUGINS.map((p) => p.id)).toEqual([BROWSER_PLUGIN_ID, ISSUES_PLUGIN_ID, CODE_PLUGIN_ID]);
    expect(BROWSER_PLUGIN_ID).toBe("hivemind/web");
    expect(BROWSER_TOOL_ID).toBe("hivemind/web/browser");
    expect(BROWSER_TOOL).toEqual({ toolId: BROWSER_TOOL_ID, tileKind: "browser" });
    expect(BUNDLED_TOOL_PLUGINS.filter((p) => p.builtin).map((p) => p.id)).toEqual([ISSUES_PLUGIN_ID, CODE_PLUGIN_ID]);
    expect(toolIdForTileKind("browser")).toBe(BROWSER_TOOL_ID);
    expect(toolIdForTileKind("diff")).toBe(`${CODE_PLUGIN_ID}/diff`);
    expect(toolIdForTileKind("shell")).toBeNull();
  });

  test("the bundled contributions pass the registry's own validation", () => {
    // createToolRegistry throws on a malformed id/key/label; building it here is
    // the assertion that the bundled metadata is well-formed.
    expect(createToolRegistry(BUNDLED_TOOL_PLUGINS).tools.map((t) => t.id)).toEqual(bundledTools().map((t) => t.id));
    expect(bundledToolRegistry.tools[0]!.label).toBe("Browser");
  });

  test("two plugins cannot contribute the same tile kind", () => {
    const clash = [
      { id: "acme/one", tools: [{ key: "diff", label: "One", tileKind: "diff" }] },
      { id: "acme/two", tools: [{ key: "diff", label: "Two", tileKind: "diff" }] },
    ];
    expect(() => createToolRegistry(clash)).toThrow(/already contributed/);
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

  test("kinds no plugin contributes answer null (the caller treats that as always available)", () => {
    for (const kind of ["shell", "editor", "claude", "terminal"]) {
      expect(tileKindAvailability(kind, prefs([]))).toBeNull();
      expect(tileKindAvailability(kind, prefs([BROWSER_PLUGIN_ID], [BROWSER_TOOL_ID]))).toBeNull();
      expect(allowed(kind, prefs([]))).toBe(true);
    }
  });

  test("a built-in tile stays available on settings that enable nothing", () => {
    // The regression this guards: making diff/issues managed must not let an
    // empty (or stale) enabledPlugins hide the editor behind a preferences blob.
    for (const kind of ["diff", "workbench", "issues", "planReview"]) {
      expect(tileKindAvailability(kind, prefs([]))?.available).toBe(true);
      expect(allowed(kind, mergeSettings({ v: 1 }).tools)).toBe(true);
    }
    // Still per-tool switchable, unlike a legacy kind.
    expect(tileKindAvailability("diff", prefs([], [`${CODE_PLUGIN_ID}/diff`])))
      .toEqual({ available: false, reason: "tool-disabled" });
  });

  test("an unknown tool id is never enabled, whatever the preferences claim", () => {
    // A stale/hand-edited enabledPlugins entry cannot conjure a tool.
    expect(bundledToolRegistry.resolve(prefs(["someone/else"])).availability("someone/else/ghost"))
      .toEqual({ available: false, reason: "not-installed" });
    expect(tileKindAvailability("ghost", prefs(["someone/else"]))).toBeNull();
  });

  test("a plugin's commands follow its tool's availability", () => {
    const ids = availableCommands(prefs([])).map((c) => c.id);
    expect(ids).toContain(`${CODE_PLUGIN_ID}/review-list`);
    // Read-only verbs are marked so an agent can run them without a prompt.
    const list = bundledToolRegistry.commands.find((c) => c.key === "review-list");
    expect(list?.readOnly).toBe(true);
    expect(bundledToolRegistry.commands.find((c) => c.key === "review-resolve")?.readOnly).toBe(false);
    // A command from a plugin that is off is not offered.
    const reg = createToolRegistry([
      { id: "acme/diff", tools: [{ key: "diff", label: "Acme" }], commands: [{ key: "ping", summary: "Ping" }] },
    ]);
    expect(availableCommands(prefs([]), reg)).toEqual([]);
    expect(availableCommands(prefs(["acme/diff"]), reg).map((c) => c.id)).toEqual(["acme/diff/ping"]);
    expect(reg.resolve(prefs([])).commandAvailability("acme/diff/ping"))
      .toEqual({ available: false, reason: "plugin-disabled" });
    expect(reg.resolve(prefs(["acme/diff"])).commandAvailability("acme/diff/nope"))
      .toEqual({ available: false, reason: "not-installed" });
  });

  test("every command an agent is told to type is a safe single line", () => {
    // The cli strings land verbatim in .agent.md, inside a fenced block.
    for (const c of bundledToolRegistry.commands) {
      expect(c.cli, c.id).toBeTruthy();
      expect(c.cli).not.toMatch(/[\n\r`]/);
    }
    expect(() => createToolRegistry([
      { id: "acme/bad", tools: [], commands: [{ key: "bad", summary: "s", cli: "hive x\nrm -rf /" }] },
    ])).toThrow(/Invalid command cli/);
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
