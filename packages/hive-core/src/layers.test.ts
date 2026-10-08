/**
 * What a list of tiles shows for each choice of its View menu: pinned tiles first and only there,
 * the status, activity and machine filters, the groupings and the orders.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { isUnread, layersView, recentGroups, workspaceCounts, type ModelTile, type RecentsBy } from "./layers.js";
import { DEFAULT_LAYERS_PREFS, type LayersPrefs } from "./settings-schema.js";

const NOW = new Date(2026, 9, 8, 15, 0).getTime();
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;
const tile = (id: string, over: Partial<ModelTile> = {}): ModelTile => ({
  id, kind: "agent-terminal", name: id, frameId: "f1", agent: "claude", status: "idle", needsYou: false, activity: NOW - HOUR / 2, machine: "local", ...over,
});
const TILES: ModelTile[] = [
  tile("b-claude", { status: "working", activity: NOW - 10 * 60_000 }),
  tile("a-codex", { agent: "codex", needsYou: true, status: "blocked", activity: NOW - 2 * HOUR }),
  tile("c-shell", { kind: "shell", agent: undefined, status: "exited", activity: NOW - 30 * HOUR, frameId: "f2" }),
  tile("d-pi", { agent: "pi", activity: null, machine: "m-1", frameId: "f3" }),
];
const view = (prefs: Partial<LayersPrefs> = {}, pinned: string[] = []) =>
  layersView({ tiles: TILES, pinned, prefs: { ...DEFAULT_LAYERS_PREFS, ...prefs }, now: NOW, agentLabel: (t) => t.agent ?? "Terminal" });
const ids = (tiles: ModelTile[]) => tiles.map((t) => t.id);

test("pinned tiles lead, in the order pinned, whatever the filters; they are not listed again below", () => {
  const v = view({ status: "working" }, ["d-pi", "a-codex", "gone"]);
  assert.deepEqual(ids(v.pinned), ["d-pi", "a-codex"]);
  assert.deepEqual([...v.byFrame.values()].flat().map((t) => t.id), ["b-claude"]);
});

test("the default lists every tile by its frame, in canvas order, with nothing filtered", () => {
  const v = view();
  assert.equal(v.tree, true);
  assert.equal(v.filtering, false);
  assert.deepEqual(ids(v.byFrame.get("f1")!), ["b-claude", "a-codex"]);
  assert.deepEqual(ids(v.byFrame.get("f3")!), ["d-pi"]);
});

test("status: needs you, working, idle and exited each keep only their own", () => {
  const all = (p: Partial<LayersPrefs>) => [...view(p).byFrame.values()].flat().map((t) => t.id).sort();
  assert.deepEqual(all({ status: "needs-you" }), ["a-codex"]);
  assert.deepEqual(all({ status: "working" }), ["b-claude"]);
  assert.deepEqual(all({ status: "idle" }), ["d-pi"]);
  assert.deepEqual(all({ status: "exited" }), ["c-shell"]);
  assert.equal(view({ status: "working" }).filtering, true);
});

test("last activity: the past hour, today or this week; a tile with no known activity is left out", () => {
  const all = (p: Partial<LayersPrefs>) => [...view(p).byFrame.values()].flat().map((t) => t.id).sort();
  assert.deepEqual(all({ activity: "hour" }), ["b-claude"]);
  assert.deepEqual(all({ activity: "today" }), ["a-codex", "b-claude"]);
  assert.deepEqual(all({ activity: "week" }), ["a-codex", "b-claude", "c-shell"]);
});

test("machines: only the tiles on the chosen computers", () => {
  assert.deepEqual([...view({ machines: ["m-1"] }).byFrame.values()].flat().map((t) => t.id), ["d-pi"]);
  assert.equal(view({ machines: ["m-1"] }).filtering, true);
});

test("group by date, status or agent gives headings in their own order; none gives one list", () => {
  assert.deepEqual(view({ groupBy: "date" }).buckets.map((b) => [b.label, ids(b.tiles)]), [
    ["Today", ["b-claude", "a-codex"]], ["Yesterday", ["c-shell"]], ["Older", ["d-pi"]],
  ]);
  assert.deepEqual(view({ groupBy: "status" }).buckets.map((b) => [b.label, ids(b.tiles)]), [
    ["Needs you", ["a-codex"]], ["Working", ["b-claude"]], ["Exited", ["c-shell"]], ["Idle", ["d-pi"]],
  ]);
  assert.deepEqual(view({ groupBy: "agent" }).buckets.map((b) => b.label), ["claude", "codex", "pi", "Terminal"]);
  const none = view({ groupBy: "none" });
  assert.equal(none.tree, false);
  assert.deepEqual(none.buckets.map((b) => [b.label, b.tiles.length]), [["", 4]]);
});

test("sort by last activity puts the newest first and the unknown last; by name, in number order", () => {
  assert.deepEqual(ids(view({ groupBy: "none", sortBy: "activity" }).buckets[0]!.tiles), ["b-claude", "a-codex", "c-shell", "d-pi"]);
  const named = layersView({ tiles: [tile("pi #10"), tile("pi #2"), tile("Alpha")], pinned: [], prefs: { ...DEFAULT_LAYERS_PREFS, groupBy: "none", sortBy: "name" }, now: NOW, agentLabel: () => "" });
  assert.deepEqual(ids(named.buckets[0]!.tiles), ["Alpha", "pi #2", "pi #10"]);
});

test("a search keeps the tiles whose name or agent holds it, pinned ones included, and counts as filtering", () => {
  const v = layersView({ tiles: TILES, pinned: ["d-pi", "b-claude"], prefs: DEFAULT_LAYERS_PREFS, now: NOW, agentLabel: (t) => t.agent ?? "Terminal", query: " CLAUDE " });
  assert.deepEqual(ids(v.pinned), ["b-claude"]);
  assert.deepEqual([...v.byFrame.values()].flat().map((t) => t.id), []);
  assert.equal(v.filtering, true);
  const byAgent = layersView({ tiles: TILES, pinned: [], prefs: DEFAULT_LAYERS_PREFS, now: NOW, agentLabel: (t) => t.agent ?? "Terminal", query: "terminal" });
  assert.deepEqual([...byAgent.byFrame.values()].flat().map((t) => t.id), ["c-shell"]);
});

test("a tile an agent started is listed under it, theirs under them; elsewhere, or alone, it is listed itself", () => {
  const tiles = [
    tile("lead"),
    tile("helper", { parent: "lead" }),
    tile("shell", { kind: "shell", agent: undefined, parent: "helper", status: "exited" }),
    tile("away", { parent: "lead", frameId: "f2" }),
    tile("loop-a", { parent: "loop-b" }),
    tile("loop-b", { parent: "loop-a" }),
  ];
  const v = (prefs: Partial<LayersPrefs> = {}) => layersView({ tiles, pinned: [], prefs: { ...DEFAULT_LAYERS_PREFS, ...prefs }, now: NOW, agentLabel: (t) => t.agent ?? "Terminal" });
  const tree = v();
  assert.deepEqual(ids(tree.byFrame.get("f1")!), ["lead", "loop-a", "loop-b"]);
  assert.deepEqual(ids(tree.kids.get("lead")!), ["helper"]);
  assert.deepEqual(ids(tree.kids.get("helper")!), ["shell"]);
  // In another frame: listed there, not under its starter.
  assert.deepEqual(ids(tree.byFrame.get("f2")!), ["away"]);
  // Filtered apart (only the exited): the shell has no starter in its list and stands alone.
  const exited = v({ groupBy: "none", status: "exited" });
  assert.deepEqual(ids(exited.buckets[0]!.tiles), ["shell"]);
  assert.equal(exited.kids.size, 0);
});

test("unread: done since it was last looked at; not while still at work, and not one never seen", () => {
  const at = NOW - HOUR;
  assert.equal(isUnread({ status: "idle", activity: at, seen: at - 1 }), true);
  assert.equal(isUnread({ status: "question", activity: at, seen: at - 1 }), true);
  assert.equal(isUnread({ status: "working", activity: at, seen: at - 1 }), false);
  assert.equal(isUnread({ status: "idle", activity: at, seen: at }), false);
  assert.equal(isUnread({ status: "idle", activity: at, seen: null }), false);
  const tiles = [tile("done", { seen: NOW - 2 * HOUR }), tile("looked", { seen: NOW })];
  const v = layersView({ tiles, pinned: [], prefs: { ...DEFAULT_LAYERS_PREFS, status: "unread", groupBy: "none" }, now: NOW, agentLabel: () => "Claude" });
  assert.deepEqual(ids(v.buckets[0]!.tiles), ["done"]);
});

test("snoozed tiles leave every list, pinned too, until their time; one that needs you is back early", () => {
  const tiles = [
    tile("later", { snoozedUntil: NOW + 2 * HOUR }),
    tile("soon", { snoozedUntil: NOW + HOUR }),
    tile("asks", { snoozedUntil: NOW + HOUR, needsYou: true, status: "question" }),
    tile("woke", { snoozedUntil: NOW - 1 }),
  ];
  const v = layersView({ tiles, pinned: ["later"], prefs: DEFAULT_LAYERS_PREFS, now: NOW, agentLabel: () => "Claude" });
  assert.deepEqual(ids(v.snoozed), ["soon", "later"]);
  assert.deepEqual(ids(v.pinned), []);
  assert.deepEqual(ids(v.byFrame.get("f1")!), ["asks", "woke"]);
});

const ROWS = [
  { agent: "claude", id: "a", folder: "/r", updated: NOW - 3 * DAY_MS, prompt: "fix the share dialog" },
  { agent: "codex", id: "b", folder: "/r", updated: NOW - HOUR, prompt: "hooks review" },
  { agent: "claude", id: "a", folder: "/r/wt", updated: NOW - 3 * DAY_MS, prompt: "fix the share dialog" },
  { agent: "claude", id: "c", folder: "/r/wt", updated: NOW - 26 * HOUR },
  { agent: "claude", id: "d", folder: "/r", updated: NOW - 10 * 60_000, prompt: "open in a tile" },
];
const groups = (by: RecentsBy, more: Partial<Parameters<typeof recentGroups>[1]> = {}) =>
  recentGroups(ROWS, { by, now: NOW, limit: () => 5, agentLabel: (a) => (a === "codex" ? "Codex" : "Claude"), ...more });
const shape = (g: ReturnType<typeof recentGroups>) => g.map((x) => [x.label, x.rows.map((r) => r.id), x.more]);

test("recents: newest first, each session once, none a tile has open, at most the limit with how many more, a search narrows", () => {
  assert.deepEqual(shape(groups("none", { open: new Set(["d"]), limit: () => 2 })), [["", ["b", "c"], 1]]);
  assert.deepEqual(shape(groups("none", { query: "SHARE" })), [["", ["a"], 0]]);
  assert.deepEqual(shape(groups("none", { query: "Codex" })), [["", ["b"], 0]]);
});

test("recents grouped by agent or project, the group with the newest session first; by date, the day's order", () => {
  assert.deepEqual(shape(groups("agent")), [["Claude", ["d", "c", "a"], 0], ["Codex", ["b"], 0]]);
  assert.deepEqual(shape(groups("project")), [["r", ["d", "b", "a"], 0], ["wt", ["c"], 0]]);
  assert.deepEqual(shape(groups("project", { folderLabel: (f) => (f === "/r" ? "manageark" : "fix-nav") })).map(([l]) => l), ["manageark", "fix-nav"]);
  assert.deepEqual(shape(groups("date")), [["Today", ["d", "b"], 0], ["Yesterday", ["c"], 0], ["This week", ["a"], 0]]);
  // Each group shows its own count: "Show more" opens one group, not all.
  assert.deepEqual(shape(groups("agent", { limit: (k) => (k === "claude" ? 1 : 5) })), [["Claude", ["d"], 2], ["Codex", ["b"], 0]]);
});

test("a workspace's counts: its tiles, the ones that need the person, the ones at work", () => {
  assert.deepEqual(workspaceCounts(["working", "blocked", "question", "idle", null, "exited"]), { tiles: 6, needsYou: 2, working: 1 });
  assert.deepEqual(workspaceCounts([]), { tiles: 0, needsYou: 0, working: 0 });
});
