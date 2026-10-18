import { describe, expect, test } from "bun:test";
import { agentSettingFields, disabledPlugins, isPluginEnabled, parsePluginStates, pluginStatesFromLegacy, serviceWorkspaces, toolSettingFields, withPluginState } from "./plugin-settings.js";

describe("what is stored for each plugin", () => {
  test("a record under a key that is not a plugin of a known kind is dropped", () => {
    const states = parsePluginStates({
      "agent:claude": { enabled: false },
      "view:@someone/notes": { options: { island: "top" } },
      "tool:hivemind/web": { enabled: true },
      "widget:pet": { options: { speed: 2 } },
      "agent:../x": { enabled: false },
      "agent:@dip497/aider": { enabled: false },
      "tool:noslash": { enabled: true },
      "toString:x": { enabled: false },
      "theme:dark": { enabled: true },
      "agent:codex": { enabled: "no", options: { "bad key": 1, n: Infinity } }, // nothing left in it
    });
    expect(Object.keys(states)).toEqual(["agent:claude", "view:@someone/notes", "tool:hivemind/web", "widget:pet"]);
  });

  test("a plugin is on unless its record says off; a kind can default to off", () => {
    const states = parsePluginStates({ "agent:codex": { enabled: false }, "tool:acme/maps": { enabled: true } });
    expect(isPluginEnabled(states, "agent", "codex")).toBe(false);
    expect(isPluginEnabled(states, "agent", "claude")).toBe(true);
    expect(isPluginEnabled(states, "tool", "acme/other", false)).toBe(false);
    expect(isPluginEnabled(states, "tool", "acme/maps", false)).toBe(true);
    expect(disabledPlugins(states, "agent")).toEqual(["codex"]);
    expect(disabledPlugins(states, "tool")).toEqual([]);
  });

  test("a record changed back to nothing is removed, not kept empty", () => {
    let states = withPluginState({}, "agent", "codex", (s) => ({ ...s, enabled: false }));
    states = withPluginState(states, "agent", "claude", (s) => ({ ...s, options: { model: "opus" } }));
    expect(states).toEqual({ "agent:codex": { enabled: false }, "agent:claude": { options: { model: "opus" } } });
    states = withPluginState(states, "agent", "codex", ({ enabled: _, ...s }) => s);
    states = withPluginState(states, "agent", "claude", (s) => ({ ...s, options: {} }));
    expect(states).toEqual({});
  });

  test("the workspaces picked for a plugin's service are folders given in full, each once; a record of only them is kept", () => {
    const states = parsePluginStates({
      "tool:acme/ci": { workspaces: ["/work/api", "relative/x", "/work/api", 7, "C:\\work\\web", "D:/w"] },
      "tool:acme/none": { workspaces: ["nope"] },
    });
    expect(serviceWorkspaces(states, "acme/ci")).toEqual(["/work/api", "C:\\work\\web", "D:/w"]);
    expect(states["tool:acme/none"]).toBeUndefined();
    expect(serviceWorkspaces(states, "acme/other")).toEqual([]);
    const picked = withPluginState({}, "tool", "acme/ci", (s) => ({ ...s, workspaces: ["/work/api"] }));
    expect(picked).toEqual({ "tool:acme/ci": { workspaces: ["/work/api"] } });
    expect(withPluginState(picked, "tool", "acme/ci", ({ workspaces: _, ...s }) => s)).toEqual({});
  });

  test("the keys of a version before plugin state are read into records", () => {
    expect(pluginStatesFromLegacy({
      agents: { disabled: ["codex", 3], options: { claude: { model: "opus", effort: 2 } } },
      plugins: { disabled: ["@someone/notes"] },
      tools: { enabledPlugins: ["hivemind/web"], disabledTools: ["hivemind/web/browser", "noslash"] },
    })).toEqual({
      "agent:codex": { enabled: false },
      "agent:claude": { options: { model: "opus" } },
      "view:@someone/notes": { enabled: false },
      "tool:hivemind/web": { enabled: true, options: { browser: false } },
    });
  });
});

describe("the settings of the kinds that declare them their own way", () => {
  test("an agent's option with its own values and no flag is a choice of them; one with a flag takes text", () => {
    expect(agentSettingFields({ options: [
      { id: "mode", label: "Mode", values: { plan: ["--plan"], yolo: ["--yolo"] } },
      { id: "model", label: "Model", flag: "--model", default: "opus" },
    ] })).toEqual([
      { id: "mode", label: "Mode", type: "choice", values: ["default", "plan", "yolo"], default: "default" },
      { id: "model", label: "Model", type: "text", default: "opus", maxLength: 200 },
    ]);
  });

  test("a tool plugin's tools are switches, each on until switched off", () => {
    expect(toolSettingFields({ tools: [{ key: "editor", label: "Editor" }, { key: "diff", label: "Diff", description: "Review changes" }] })).toEqual([
      { id: "editor", label: "Editor", type: "boolean", default: true },
      { id: "diff", label: "Diff", type: "boolean", default: true, description: "Review changes" },
    ]);
  });
});
