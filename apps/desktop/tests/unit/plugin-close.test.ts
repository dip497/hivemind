// `hive ctl plugin close` closes what `plugin open` opened, named the way open names it
// (`widget:@owner/name`, `tool:@owner/name`) or by the instance `plugin list` shows; and it takes
// off the board any widget an agent can add, a built-in one drawn without code too. `plugin list`
// names every widget and the view one a view brought shows over alone, and `plugin open` with that
// id shows it over every view, as the card's pin does.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Running } from "@hivemind/view-host/instances";
import type { PluginList } from "@hivemind/workspace-api/plugins";
import { pluginVerb, type PluginVerbHost } from "../../src/renderer/src/workspace/plugin-verbs";
import { pluginInstances } from "../../src/renderer/src/workspace/plugin-instances";
import { FALLBACK_VIEW_ID } from "../../src/renderer/src/workspace/workspace-view";

const started: Running[] = [];
afterEach(() => { for (const r of started.splice(0)) r.stop(); });

/** A window: its board's widgets and its tiles. A widget or tile with code runs while it is there. */
function openWindow() {
  const board = new Map<string, { widget: string; view?: string; running?: Running }>();
  const tiles = new Map<string, Running>();
  const run = (plugin: string, kind: "widget" | "tool", instance: string): Running => {
    const r = pluginInstances.start({ plugin, kind, instance, label: plugin, commands: [], call: async () => null });
    r.connected();
    started.push(r);
    return r;
  };
  const host: PluginVerbHost = {
    activeView: () => FALLBACK_VIEW_ID, showView: () => {}, addWidget: () => undefined, hasWidget: () => false, widgetRuns: () => false,
    closeTile: (id) => { tiles.get(id)?.stop(); tiles.delete(id); },
    widgetsOnBoard: () => [...board].map(([id, w]) => ({ id, widget: w.widget, placement: "screen" as const, ...(w.view ? { view: w.view } : {}) })),
    removeWidget: (id) => { board.get(id)?.running?.stop(); board.delete(id); },
    showOnEveryView: (id) => { const w = board.get(id); if (w) delete w.view; },
  };
  return {
    host, board, tiles,
    widget: (id: string, widget: string, code: boolean, view?: string) => board.set(id, { widget, ...(view ? { view } : {}), ...(code ? { running: run(widget, "widget", id) } : {}) }),
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
  w.tool("tile-9", "@me/worktrees");
  assert.deepEqual(await close(w.host, "tool:@me/worktrees"), { closed: "tile-9", plugin: "@me/worktrees", kind: "tool" });
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

test("plugin open by the id alone: the widget that has it is added; where none does, it says so", async () => {
  const w = openWindow();
  const added: string[] = [];
  const host: PluginVerbHost = { ...w.host, hasWidget: (id) => id === "@me/progress", addWidget: (id) => { added.push(id); return "widget-9"; } };
  assert.deepEqual(await pluginVerb("plugin.open", { kind: "any", id: "@me/progress" }, host), { widget: "widget-9" });
  assert.deepEqual(added, ["@me/progress"]);
  await assert.rejects(pluginVerb("plugin.open", { kind: "any", id: "@me/nothing" }, host), { code: "NOT_FOUND" });
});

test("plugin list names every widget and the view a brought one shows over; plugin open by its id shows it over every view, adding none", async () => {
  const w = openWindow();
  // Harbour came with Archipelago and is not drawn on the canvas, so its code is not running.
  w.widget("widget-h", "@me/harbour", false, "@me/archipelago");
  w.widget("widget-n", "note", false);
  w.widget("widget-p", "@me/progress", true);
  const added: string[] = [];
  const host: PluginVerbHost = { ...w.host, hasWidget: () => true, addWidget: (id) => { added.push(id); return "widget-new"; } };
  const list = await pluginVerb("plugin.list", {}, host) as PluginList;
  assert.deepEqual(list.widgets, [
    { instance: "widget-h", widget: "@me/harbour", placement: "screen", view: "@me/archipelago", running: false },
    { instance: "widget-n", widget: "note", placement: "screen", running: false },
    { instance: "widget-p", widget: "@me/progress", placement: "screen", running: true },
  ]);
  assert.deepEqual(await pluginVerb("plugin.open", { kind: "any", id: "widget-h" }, host), { widget: "widget-h" });
  assert.equal(w.board.get("widget-h")?.view, undefined);
  assert.deepEqual(added, []);
  // By its package, as before: another copy.
  assert.deepEqual(await pluginVerb("plugin.open", { kind: "widget", id: "@me/harbour" }, host), { widget: "widget-new" });
  assert.deepEqual(added, ["@me/harbour"]);
});

test("a widget open twice is refused with each copy's id and the view a brought one shows over", async () => {
  const w = openWindow();
  w.widget("widget-a", "@me/harbour", false, "@me/archipelago");
  w.widget("widget-b", "@me/harbour", false);
  await assert.rejects(close(w.host, "widget:@me/harbour"), (e: Error & { code?: string }) => e.code === "BAD_REQUEST" && e.message.endsWith("widget-a (over @me/archipelago), widget-b"));
});
