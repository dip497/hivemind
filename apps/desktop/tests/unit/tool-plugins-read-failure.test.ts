/**
 * The tool plugins the app reads over the bridge: a read that fails keeps the tiles it had
 * registered, so no tool's tile turns into "not installed", and the Plugins page's tools tab says why.
 *
 * The module binds `window.hive` when it starts, so the fake bridge is installed before the import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS, mergeSettings } from "@hivemind/core/settings-schema";

const prs = {
  id: "@ada/prs", name: "Pull requests", description: "PRs.", source: "you", category: "git", entry: "index.js", settings: [],
  tools: [{ key: "prs", label: "Pull requests", tileKind: "ada-prs" }], tiles: { "ada-prs": { size: { width: 400, height: 300 }, glyph: "P" } },
};
let read: () => Promise<unknown> = async () => ({ packages: [prs], safeMode: false });
let changed: () => void = () => {};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: { getItem: () => null },
  HTMLIFrameElement: class {},
  hive: {
    settingsSync: () => mergeSettings({ ...DEFAULT_SETTINGS, plugins: { ...DEFAULT_SETTINGS.plugins, state: { "tool:@ada/prs": { enabled: true } } } }),
    onSettingsChanged: () => () => {},
    toolPackages: () => read(),
    onToolsChanged: (cb: () => void) => { changed = cb; return () => {}; },
  },
};

const { ToolPlugins } = await import("../../src/renderer/src/tiles/tool-plugins");
const { useToolRows } = await import("../../src/renderer/src/settings-tools");
const { tilePlugin } = await import("../../src/renderer/src/tiles/api");

/** The tools tab's warning, as the window shows it now. */
let warning: string | null = null;
const Window = () => { warning = useToolRows(() => true).warning; return createElement(ToolPlugins); };
const listens = { addEventListener() {}, removeEventListener() {} };
const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml", ownerDocument: listens, ...listens };
const root = createRoot(container as never);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("a failed read keeps the installed tool's tiles and the Plugins page says why", async () => {
  await act(async () => { root.render(createElement(Window)); });
  await settle();
  assert.ok(tilePlugin("tool:@ada/prs"), "registered once read");
  assert.equal(warning, null);

  read = () => Promise.reject(new Error("EACCES: packages/installed.json"));
  await act(async () => { changed(); });
  await settle();
  assert.ok(tilePlugin("tool:@ada/prs"), "still registered after a failed read");
  assert.match(warning ?? "", /could not be read: EACCES: packages\/installed\.json/);

  read = async () => ({ packages: [prs], safeMode: false });
  await act(async () => { changed(); });
  await settle();
  assert.ok(tilePlugin("tool:@ada/prs"));
  assert.equal(warning, null);
  await act(async () => { root.unmount(); });
});
