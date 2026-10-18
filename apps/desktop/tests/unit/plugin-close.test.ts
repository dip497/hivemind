// `hive ctl plugin close` closes what `plugin open` opened, named the way open names it
// (`widget:@owner/name`, `tool:owner/name`) or by the instance `plugin list` shows; and it takes
// off the board any widget an agent can add, a built-in one drawn without code too.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Running } from "@hivemind/view-host/instances";
import { pluginVerb, type PluginVerbHost } from "../../src/renderer/src/workspace/plugin-verbs";
import { pluginInstances } from "../../src/renderer/src/workspace/plugin-instances";
import { FALLBACK_VIEW_ID } from "../../src/renderer/src/workspace/workspace-view";

const started: Running[] = [];
afterEach(() => { for (const r of started.splice(0)) r.stop(); });

/** A window: its board's widgets and its tiles. A widget or tile with code runs while it is there. */
function openWindow() {
  const board = new Map<string, { widget: string; running?: Running }>();
  const tiles = new Map<string, Running>();
  const run = (plugin: string, kind: "widget" | "tool", instance: string): Running => {
    const r = pluginInstances.start({ plugin, kind, instance, label: plugin, commands: [], call: async () => null });
    r.connected();
    started.push(r);
    return r;
  };
  const host: PluginVerbHost = {
    activeView: () => FALLBACK_VIEW_ID, showView: () => {}, addWidget: () => undefined, widgetRuns: () => false,
    closeTile: (id) => { tiles.get(id)?.stop(); tiles.delete(id); },
    widgetsOnBoard: () => [...board].map(([id, w]) => ({ id, widget: w.widget })),
    removeWidget: (id) => { board.get(id)?.running?.stop(); board.delete(id); },
  };
  return {
    host, board, tiles,
    widget: (id: string, widget: string, code: boolean) => board.set(id, { widget, ...(code ? { running: run(widget, "widget", id) } : {}) }),
    tool: (tile: string, plugin: string) => tiles.set(tile, run(plugin, "tool", tile)),
  };
}
const close = (host: PluginVerbHost, which: string) => pluginVerb("plugin.close", { instance: which }, host);

test("a widget with code closes by the id plugin open takes, as by its instance", async () => {
  const w = openWindow();
  w.widget("widget-1", "@me/progress", true);
  assert.deepEqual(await close(w.host, "widget:@me/progress"), { closed: "widget-1", plugin: "@me/progress", kind: "widget" });
  assert.deepEqual([...w.board.keys()], []);
  assert.equal(pluginInstances.find({ instance: "widget-1" }), undefined);
  w.widget("widget-3", "@me/progress", true);
  assert.deepEqual(await close(w.host, "widget-3"), { closed: "widget-3", plugin: "@me/progress", kind: "widget" });
});

test("a tool closes by its plugin id, its tile closing", async () => {
  const w = openWindow();
  w.tool("tile-9", "me/worktrees");
  assert.deepEqual(await close(w.host, "tool:me/worktrees"), { closed: "tile-9", plugin: "me/worktrees", kind: "tool" });
  assert.deepEqual([...w.tiles.keys()], []);
});

test("a built-in widget without code comes off the board by its id or by widget:<id>", async () => {
  const w = openWindow();
  w.widget("widget-a", "checklist", false);
  w.widget("widget-b", "note", false);
  assert.deepEqual(await close(w.host, "widget-a"), { closed: "widget-a", plugin: "checklist", kind: "widget" });
  assert.deepEqual(await close(w.host, "widget:note"), { closed: "widget-b", plugin: "note", kind: "widget" });
  assert.deepEqual([...w.board.keys()], []);
});

test("a plugin id that names two copies is refused with their ids; one that names none is not found", async () => {
  const w = openWindow();
  w.widget("widget-a", "checklist", false);
  w.widget("widget-b", "checklist", false);
  await assert.rejects(close(w.host, "widget:checklist"), (e: Error & { code?: string }) => e.code === "BAD_REQUEST" && /widget-a, widget-b/.test(e.message));
  await assert.rejects(close(w.host, "widget:@me/absent"), (e: Error & { code?: string }) => e.code === "NOT_FOUND");
  assert.deepEqual([...w.board.keys()], ["widget-a", "widget-b"]);
});
