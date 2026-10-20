// Settings ▸ Plugins has one tab per kind, as HiveHub's home does, then Packages: a plugin shows
// under its own kind's tab only, grouped by category, and each tab's count is what that tab lists.
// A package of several is one row of the Packages tab; its members stay in their kinds' tabs,
// marked as part of it, and none can be switched on while it is off. A package of one is only its
// plugin's row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsInKindTab } from "../../src/renderer/src/plugins/kinds.ts";
import { heldOffByPackage, packageRows, partOfPackage } from "../../src/renderer/src/plugins/package-rows.ts";
import type { InstalledPackageInfo } from "../../src/shared/ipc.ts";

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
  assert.deepEqual(rowsInKindTab(rows, "agent").counts, { agent: 2, view: 1, widget: 4, tool: 1, package: 0 });
  assert.deepEqual(shown("package"), []);
});

test("a package of several is a Packages row and its members stay in their kinds' tabs, marked; a package of one is only its plugin", () => {
  const installed: InstalledPackageInfo[] = [
    { id: "@ada/kit", name: "Kit", version: "1.1.0", on: false, previous: { version: "1.0.0", on: true },
      members: [{ kind: "tool", id: "@ada/prs", runs: "in the app" }, { kind: "widget", id: "@ada/dog", runs: "sandboxed" }, { kind: "view", id: "@ada/board", runs: "sandboxed" }] },
    { id: "@ada/pet", name: "Pet", version: "1.0.0", on: false, previous: null, members: [{ kind: "widget", id: "@ada/pet", runs: "sandboxed" }] },
  ];
  // Each plugin as the app reads it: with the package it came in.
  const plugins = installed.flatMap((p) => p.members.map((m) => ({
    kind: m.kind as "tool" | "widget" | "view", id: m.id, package: { id: p.id, name: p.name, version: p.version, on: p.on, members: p.members.length },
  })));
  const listed = [
    ...plugins.map((p) => ({ key: `${p.kind}:${p.id}`, kind: p.kind, category: "other" as const, partOf: partOfPackage(p)?.name ?? null })),
    ...packageRows(installed, {}, () => undefined).map((p) => ({ key: `package:${p.id}`, kind: "package" as const, category: "other" as const, partOf: null })),
  ];
  const tab = (t: Parameters<typeof rowsInKindTab>[1]) => rowsInKindTab(listed, t).groups.flatMap(([, list]) => list.map((r) => [r.key, r.partOf]));
  assert.deepEqual(tab("package"), [["package:@ada/kit", null]]);
  assert.deepEqual(tab("widget"), [["widget:@ada/dog", "Kit"], ["widget:@ada/pet", null]]);
  assert.deepEqual(tab("tool"), [["tool:@ada/prs", "Kit"]]);
  assert.deepEqual(rowsInKindTab(listed, "package").counts, { agent: 0, view: 1, widget: 2, tool: 1, package: 1 });
  // Kit is off: its members wait on it; Pet, off too, is switched by its own row.
  assert.deepEqual(plugins.map((p) => [p.id, heldOffByPackage(p)]), [["@ada/prs", true], ["@ada/dog", true], ["@ada/board", true], ["@ada/pet", false]]);
});
