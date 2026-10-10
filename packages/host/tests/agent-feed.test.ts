// The agent feed (agent-feed.ts): readers list, then are told each change once, numbered on from
// the list; what a change means comes as events; changes in a burst are worked out once; a reader
// that missed some catches up, or lists again when the feed no longer keeps them; each workspace's
// changes reach its own folder only.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { AgentFeed, type AgentChange, type AgentEvent, type AgentFeedOptions } from "../src/agent-feed.ts";

const agent = (tile: string, over: Partial<AgentItem> = {}): AgentItem =>
  ({ workspace: "ws-a", name: "api", tile, agent: `claude #${tile}`, state: "working", since: 1, machine: "here", ...over });

function feed(start: AgentItem[], keep?: number, answerOf?: AgentFeedOptions["answerOf"]) {
  let now = start;
  const told: Array<{ event: string; repo: string; payload: AgentChange | AgentEvent }> = [];
  const f = new AgentFeed({
    build: () => now,
    publish: (event, repo, payload) => told.push({ event, repo, payload }),
    repoOf: (ws) => ({ "ws-a": "/a", "ws-b": "/b" } as Record<string, string>)[ws] ?? null,
    every: 250,
    ...(keep ? { keep } : {}),
    ...(answerOf ? { answerOf } : {}),
  });
  return { f, told, set: (next: AgentItem[]) => { now = next; } };
}
const events = (told: ReturnType<typeof feed>["told"]) => told.filter((t) => t.event === "agent.event").map((t) => `${(t.payload as AgentEvent).tile}:${(t.payload as AgentEvent).kind}${(t.payload as AgentEvent).detail ? `:${(t.payload as AgentEvent).detail}` : ""}`);

test("a reader lists, then is told each change once, and what it means", () => {
  const h = feed([agent("1")]);
  assert.deepEqual(h.f.list("ws-a"), { seq: 0, agents: [agent("1")] });

  h.set([agent("1", { state: "done" }), agent("2")]);
  h.f.refresh();
  h.set([agent("1", { state: "working", waiting: { kind: "permission", since: 5 } }), agent("2")]);
  h.f.refresh();
  h.f.refresh(); // nothing changed: nothing told
  h.set([agent("1", { state: "working" })]);
  h.f.refresh();

  assert.deepEqual(events(h.told), ["1:turnEnded:done", "2:came", "1:waiting:permission", "1:answered", "2:went"]);
  const seqs = h.told.map((t) => t.payload.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "numbered in order");
  assert.equal(new Set(seqs).size, seqs.length, "each number once");
  assert.equal(h.f.list("ws-a").seq, seqs.at(-1));
});

test("a burst of status changes is worked out once, at most every 250 ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let builds = 0;
  let now = [agent("1")];
  const f = new AgentFeed({ build: () => { builds++; return now; }, publish: () => {}, repoOf: () => "/a", every: 250 });
  builds = 0;
  f.changed(); // first after a quiet spell: at once
  now = [agent("1", { state: "done" })];
  for (let i = 0; i < 20; i++) f.changed();
  assert.equal(builds, 1);
  t.mock.timers.tick(250);
  assert.equal(builds, 2);
  assert.equal(f.list("ws-a").agents[0]!.state, "done");
});

test("a reader that lists or catches up while a change waits out the interval is given it worked out, and told it once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let now = [agent("1")];
  const told: string[] = [];
  const f = new AgentFeed({ build: () => now, publish: (event) => told.push(event), repoOf: () => "/a", every: 250 });
  f.changed(); // first after a quiet spell: at once
  const from = f.list("ws-a").seq;
  now = [agent("1", { agent: "renamed" })];
  f.changed();
  assert.equal(f.list("ws-a").agents[0]!.agent, "renamed");
  now = [agent("1", { agent: "again" })];
  f.changed();
  assert.deepEqual(f.since("ws-a", from)!.changes.map((c) => "agent" in c && c.agent.agent), ["renamed", "again"]);
  t.mock.timers.tick(250);
  assert.deepEqual(told, ["agent.changed", "agent.changed"]);
});

test("a reader that missed changes catches up on its own workspace's; past what is kept, it lists again", () => {
  const h = feed([agent("1"), agent("9", { workspace: "ws-b" })], 4);
  const from = h.f.list("ws-a").seq;
  h.set([agent("1", { state: "done" }), agent("9", { workspace: "ws-b", state: "done" })]);
  h.f.refresh();
  const caught = h.f.since("ws-a", from)!;
  assert.deepEqual(caught.changes.map((c) => ("agent" in c ? c.agent.tile : c.gone)), ["1"]);
  assert.deepEqual(caught.events.map((e) => e.kind), ["turnEnded"]);

  for (let i = 0; i < 4; i++) { h.set([agent("1", { since: 10 + i })]); h.f.refresh(); }
  assert.equal(h.f.since("ws-a", from), null, "older than the feed keeps: list again");
  assert.equal(h.f.since("ws-a", 999), null, "ahead of the feed: list again");
});

test("each workspace's changes go to its own folder, and none for a workspace not held here", () => {
  const h = feed([]);
  h.set([agent("1"), agent("2", { workspace: "ws-b" }), agent("3", { workspace: "ws-gone" })]);
  h.f.refresh();
  assert.deepEqual([...new Set(h.told.map((t) => `${t.repo}:${"agent" in t.payload ? t.payload.agent.tile : "tile" in t.payload ? t.payload.tile : ""}`))],
    ["/a:1", "/b:2"]);
});

test("what a worker reports to the program that started it is told to its workspace's readers, numbered on, and kept for one catching up", () => {
  const h = feed([agent("1"), agent("2", { workspace: "ws-b" })]);
  h.f.report("1", "done: 3 files");
  h.f.report("gone", "nobody hears this");
  assert.deepEqual(events(h.told), ["1:reported:done: 3 files"]);
  assert.equal(h.told[0]!.repo, "/a");
  assert.deepEqual(h.f.since("ws-a", 0)?.events.map((e) => [e.kind, e.detail]), [["reported", "done: 3 files"]]);
  assert.deepEqual(h.f.since("ws-b", 0)?.events, []);
});

test("a wait that ends is told answered, with the decision and who gave it when it was decided; one replaced by another wait ended too", () => {
  const priya = { person: "p".repeat(64), name: "Priya" };
  const h = feed([agent("1", { state: "waiting", waiting: { kind: "plan", since: 5, plan: "1. Split" } })], undefined, (tile, since) => (tile === "1" && since === 5 ? { decision: "deny", by: priya } : undefined));
  h.set([agent("1", { state: "waiting", waiting: { kind: "permission", since: 9 } })]);
  h.f.refresh();
  h.set([agent("1")]);
  h.f.refresh();
  assert.deepEqual(events(h.told), ["1:answered:deny", "1:waiting:permission", "1:answered"]);
  const answered = h.told.map((t) => t.payload as AgentEvent).filter((e) => e.kind === "answered");
  assert.deepEqual(answered.map((e) => e.by), [priya, undefined]);
});
