// Settings ▸ Plugins has one tab per kind, as HiveHub's home does: a plugin shows under its own
// kind's tab only, grouped by category, and each tab's count is what that tab lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsInKindTab } from "../../src/renderer/src/plugins/kinds.ts";

const rows = [
  { key: "tool:web", kind: "tool", category: "web" },
  { key: "agent:claude", kind: "agent", category: "agents" },
  { key: "widget:status", kind: "widget", category: "agents" },
  { key: "view:board", kind: "view", category: "agents" },
  { key: "widget:clock", kind: "widget", category: "fun" },
  { key: "widget:note", kind: "widget", category: "productivity" },
  { key: "widget:diff", kind: "widget", category: "code" },
  { key: "agent:codex", kind: "agent", category: "agents" },
] as const;

const shown = (tab: Parameters<typeof rowsInKindTab>[1]) =>
  rowsInKindTab(rows, tab).groups.map(([category, list]) => [category, list.map((r) => r.key)]);

test("each kind's tab lists only that kind, under its categories in the Add menu's order, empty ones left out", () => {
  assert.deepEqual(shown("agent"), [["agents", ["agent:claude", "agent:codex"]]]);
  assert.deepEqual(shown("widget"), [
    ["code", ["widget:diff"]], ["agents", ["widget:status"]], ["productivity", ["widget:note"]], ["fun", ["widget:clock"]],
  ]);
  assert.deepEqual(shown("view"), [["agents", ["view:board"]]]);
  assert.deepEqual(shown("tool"), [["web", ["tool:web"]]]);
  assert.deepEqual(rowsInKindTab(rows, "agent").counts, { agent: 2, view: 1, widget: 4, tool: 1 });
});
