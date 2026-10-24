// Home, as the person's phone follows it (home.ts, keyed-feed.ts, spec/home.md): rows numbered as
// they change, caught up after a position the host still keeps, else given whole; worked out at
// most every 250 ms however often things change; and what each row says, held to
// conformance/home.json's cases for a computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HomeMessage } from "@hivemind/workspace-api/home";
import { KeyedFeed } from "../src/keyed-feed.ts";
import os from "node:os";
import { HomeFeed, homeLines, homeRows, workspaceSummaries, type LayersShown } from "../src/home.ts";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { boardStructure } from "../src/board-structure.ts";
import type { HeldBoard } from "../src/needs.ts";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import type { KnownMachines } from "@hivemind/core/remote-uri";
import { AGENT_MANIFEST_VERSION, agentById, defFromManifest, setCatalog } from "@hivemind/agents";

const machines: KnownMachines = { self: () => ({ device: "d1", name: "desk" }), mine: () => undefined, whose: () => undefined, saved: (id) => (id === "m1" ? "build box" : undefined) };

test("rows are numbered as they change or go, and a follower behind the last kept, by count or by size, is told to take them whole", () => {
  const feed = new KeyedFeed<string>({ keep: 3, bytes: 1000 });
  assert.deepEqual(feed.set(new Map([["a", "1"], ["b", "2"]])).map((c) => c.seq), [1, 2]);
  assert.deepEqual(feed.set(new Map([["a", "1"], ["b", "2"]])), [], "the same rows say nothing");
  assert.deepEqual(feed.set(new Map([["a", "3"]])), [{ seq: 3, key: "a", row: "3" }, { seq: 4, key: "b", gone: true }]);
  assert.deepEqual(feed.snapshot(), { seq: 4, rows: [["a", "3"]] });
  assert.deepEqual(feed.since(2)?.changes.map((c) => c.seq), [3, 4]);
  assert.deepEqual(feed.since(4), { seq: 4, changes: [] }, "up to date: nothing");
  assert.equal(feed.since(0), null, "change 1 is no longer kept: three are");
  assert.deepEqual(feed.since(1)?.changes.map((c) => c.seq), [2, 3, 4]);
  for (const seq of [5, -1, 1.5]) assert.equal(feed.since(seq), null, `${seq}: never given`);
  const small = new KeyedFeed<string>({ keep: 100, bytes: 30 });
  small.set(new Map([["a", "x".repeat(10)]]));
  small.set(new Map([["a", "y".repeat(10)]]));
  small.set(new Map([["a", "z".repeat(10)]]));
  assert.equal(small.since(0), null, "past 30 bytes the oldest go");
  assert.deepEqual(small.since(2)?.changes.map((c) => c.seq), [3]);
});

test("Home is worked out at most every `every` ms, the first change at once, and tells each follower what changed; a follower is answered what came after its positions, or both sequences whole", async () => {
  let rows = new Map([["w:w1", { of: "workspace" as const, workspace: "w1", name: "api" }]]);
  let lines = new Map<string, string>();
  let worked = 0;
  const feed = new HomeFeed({ rows: () => (worked++, rows), lines: () => lines, every: 50 });
  const heard: HomeMessage[] = [];
  const stop = feed.follow((m) => heard.push(m));
  const first = feed.answer({});
  assert.equal(first.t, "home");
  assert.deepEqual(first.t === "home" && [first.layout.seq, first.lines.seq], [1, 0]);
  rows = new Map([...rows, ["w:w2", { of: "workspace", workspace: "w2", name: "web" }]]);
  lines = new Map([["t:w1/t1", "building"]]);
  worked = 0;
  feed.changed();
  assert.equal(worked, 1, "the first change, at once");
  feed.changed();
  feed.changed();
  assert.equal(worked, 1, "the next within 50 ms wait");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(worked, 2, "and are worked out together at its end");
  assert.deepEqual(heard, [{
    t: "changes",
    layout: { seq: 2, changes: [{ seq: 2, key: "w:w2", row: { of: "workspace", workspace: "w2", name: "web" } }] },
    lines: { seq: 1, changes: [{ seq: 1, key: "t:w1/t1", row: "building" }] },
  }]);
  assert.deepEqual(feed.answer({ layout: 1, lines: 0 }), heard[0], "caught up from where it was");
  assert.equal(feed.answer({ layout: 1 }).t, "home", "a position for one sequence only: both whole");
  assert.equal(feed.answer({ layout: 9, lines: 0 }).t, "home", "a position never given: both whole");
  stop();
  lines = new Map();
  feed.refresh();
  assert.equal(heard.length, 1, "stopped: told no more");
  feed.close();
});

test("a line that changes works out Home's lines alone, never its layout's rows", () => {
  const rows = new Map([["w:w1", { of: "workspace" as const, workspace: "w1", name: "api" }]]);
  let lines = new Map<string, string>();
  let worked = 0;
  const feed = new HomeFeed({ rows: () => (worked++, rows), lines: () => lines, every: 0 });
  const heard: HomeMessage[] = [];
  feed.follow((m) => heard.push(m));
  worked = 0;
  lines = new Map([["t:w1/t1", "214 tests passed"]]);
  feed.linesChanged();
  assert.equal(worked, 0, "no row of the layout worked out");
  assert.deepEqual(heard, [{ t: "changes", lines: { seq: 1, changes: [{ seq: 1, key: "t:w1/t1", row: "214 tests passed" }] } }]);
  feed.changed();
  assert.equal(worked, 1, "anything else still works out the layout");
  feed.close();
});

test("with no one following, Home is not worked out on a change; the next to ask is answered it, caught up", () => {
  let rows = new Map([["w:w1", { of: "workspace" as const, workspace: "w1", name: "api" }]]);
  let worked = 0;
  const feed = new HomeFeed({ rows: () => (worked++, rows), lines: () => new Map(), every: 50 });
  worked = 0;
  rows = new Map([...rows, ["w:w2", { of: "workspace", workspace: "w2", name: "web" }]]);
  feed.changed();
  feed.changed();
  assert.equal(worked, 0, "no one follows: nothing worked out");
  assert.deepEqual(feed.answer({ layout: 1, lines: 0 }), {
    t: "changes",
    layout: { seq: 2, changes: [{ seq: 2, key: "w:w2", row: { of: "workspace", workspace: "w2", name: "web" } }] },
    lines: { seq: 0, changes: [] },
  });
  assert.equal(worked, 1);
  feed.close();
});

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../conformance/home.json");
const { computer: cases } = JSON.parse(fs.readFileSync(file, "utf8")) as {
  computer: Array<{ about: string; held: HeldBoard[]; agents: AgentItem[]; titles?: Record<string, string>; spawns?: Array<{ parent: string; child: string }>; shown?: Record<string, LayersShown>; lines?: Record<string, string>; rows: Record<string, unknown>; said: Record<string, string> }>;
};

for (const c of cases) {
  test(`a computer: ${c.about}`, () => {
    const rows = homeRows({
      held: c.held,
      agents: c.agents,
      structure: (core) => boardStructure(core, { title: (id) => c.titles?.[id], links: () => ({ pipes: [], spawns: c.spawns ?? [] }), machines }).structure,
      shown: (repo) => c.shown?.[repo],
    });
    assert.deepEqual(Object.fromEntries(rows), c.rows);
    assert.deepEqual(Object.fromEntries(homeLines(c.held, (t) => c.lines?.[t])), c.said);
  });
}

test("each agent a tile runs is a row of its own, once, keyed by its id: its name and its mark's shapes as its manifest draws them; a shell runs none", (t) => {
  const icon = { viewBox: "0 0 24 24", attrs: { fill: "currentColor" }, shapes: [{ circle: { cx: "12", cy: "12", r: "10" } }, { path: { d: "M4 4a8 8 0 0 1 16 0" } }] };
  setCatalog([defFromManifest({
    manifestVersion: AGENT_MANIFEST_VERSION, id: "acme", label: "Acme", bin: "acme", icon,
    caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false },
  })]);
  t.after(() => setCatalog([]));
  const held: HeldBoard[] = [{ workspace: "w1", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [
    { id: "t1", kind: "claude", cmd: "acme", label: "Acme 1" },
    { id: "t2", kind: "claude", cmd: "acme", label: "Acme 2" },
    { id: "t3", kind: "shell", label: "Shell" },
  ] } as never }];
  const rows = homeRows({ held, agents: [], structure: (core) => boardStructure(core, { title: () => undefined, links: () => ({ pipes: [], spawns: [] }), machines }).structure, shown: () => undefined, agent: agentById });
  const agentRows = [...rows].filter(([k]) => k.startsWith("a:"));
  assert.deepEqual(agentRows, [["a:acme", { of: "agent", id: "acme", label: "Acme", icon }]]);
  assert.equal((rows.get("t:w1/t1") as { agent?: string }).agent, "acme", "its tile names it");
  assert.equal((rows.get("t:w1/t3") as { agent?: string }).agent, undefined);
});

test("the Layers panel's Projects list a folder only set up for issues, and leave it out of the workspaces this computer holds", () => {
  const store = new WorkspaceStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "hm-summaries-")), person: newSeed() });
  const opened = "/work/opened";
  const issuesOnly = "/work/issues-only";
  store.setCore(opened, { frames: [], tiles: [{ id: "t1", kind: "claude", label: "claude #1" }], tileNames: {}, editorTabs: {}, frameOf: {} } as never, {});

  const listed = workspaceSummaries(store, [{ repo: opened }, { repo: issuesOnly }], (tile) => (tile === "t1" ? "working" : null));

  assert.deepEqual(listed, [
    { repo: issuesOnly, title: "issues-only", tiles: 0, needsYou: 0, working: 0 },
    { repo: opened, title: "opened", tiles: 1, needsYou: 0, working: 1 },
  ]);
  // What `hive ctl` is told is open here: run in that folder, it would start its agents there.
  assert.deepEqual(store.repos(), [opened]);
});
