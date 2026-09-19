import { describe, expect, test } from "bun:test";
import { createToolRegistry } from "./tool-registry";
const browser = "hivemind/web/browser";
const files = "hivemind/code/files";
const diff = "hivemind/code/diff";
const plugins = [
  { id: "hivemind/web", tools: [{ key: "browser", label: "Browser" }] },
  { id: "hivemind/code", tools: [{ key: "files", label: "Files" }, { key: "diff", label: "Diff" }] },
];
describe("optional tool registry proof", () => {
  test("installation never enables a tool", () => {
    const state = createToolRegistry(plugins).resolve({ enabledPlugins: [] });
    expect(state.visible).toEqual([]);
    expect(state.availability(browser)).toEqual({ available: false, reason: "plugin-disabled" });
  });
  test("one package can enable several tools while individual tools remain disabled", () => {
    const state = createToolRegistry(plugins).resolve({ enabledPlugins: ["hivemind/code"], disabledTools: [diff] });
    expect(state.visible.map((t) => t.id)).toEqual([files]);
    expect(state.availability(diff)).toEqual({ available: false, reason: "tool-disabled" });
  });
  test("view order and visibility cannot activate unavailable tools", () => {
    const registry = createToolRegistry(plugins);
    const state = registry.resolve({ enabledPlugins: ["hivemind/code"], visibleTools: [diff, browser, "unknown", files, diff] });
    expect(state.visible.map((t) => t.id)).toEqual([diff, files]);
    const empty = registry.resolve({ enabledPlugins: ["hivemind/code"], visibleTools: [] });
    expect(empty.visible).toEqual([]);
    expect(empty.availability(files).available).toBe(true);
  });
  test("preferences are snapshotted and metadata identity survives view changes", () => {
    const registry = createToolRegistry(plugins);
    const enabledPlugins = ["hivemind/code"];
    const before = registry.resolve({ enabledPlugins });
    enabledPlugins.length = 0;
    expect(before.availability(files).available).toBe(true);
    const reordered = registry.resolve({ enabledPlugins: ["hivemind/code"], visibleTools: [diff, files] });
    expect(reordered.visible[1]).toBe(before.visible[0]);
    expect(registry.resolve({ enabledPlugins }).visible).toEqual([]);
  });
  test("different plugins can contribute the same local tool key", () => {
    const registry = createToolRegistry([...plugins, { id: "community/web", tools: [{ key: "browser", label: "Another browser" }] }]);
    expect(registry.tools).toHaveLength(4);
    expect(registry.resolve({ enabledPlugins: ["community/web"] }).visible[0]?.id).toBe("community/web/browser");
  });
  test("removed tools are unavailable without altering an earlier metadata snapshot", () => {
    const old = createToolRegistry(plugins);
    const next = createToolRegistry([]).resolve({ enabledPlugins: ["hivemind/web"] });
    expect(next.availability(browser)).toEqual({ available: false, reason: "not-installed" });
    expect(old.tools[0]?.id).toBe(browser);
  });
  test("duplicate identities and invalid metadata are rejected", () => {
    expect(() => createToolRegistry([plugins[0]!, plugins[0]!])).toThrow("Duplicate");
    expect(() => createToolRegistry([{ id: "hivemind/web", tools: [{ key: "browser", label: "Browser" }, { key: "browser", label: "Other" }] }])).toThrow("Duplicate");
    expect(() => createToolRegistry([{ id: "../invalid", tools: [] }])).toThrow("Invalid");
    expect(() => createToolRegistry([{ id: "hivemind/web", tools: [{ key: "../browser", label: "Browser" }] }])).toThrow("Invalid");
    expect(() => createToolRegistry([{ id: "hivemind/web", tools: [{ key: "browser", label: "\u0000" }] }])).toThrow("Invalid");
  });
});
