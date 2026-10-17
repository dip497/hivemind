// Agents put to sleep and woken by the control plane (control/methods.ts, plane.ts), over a real
// workspace store: a frame's agents sleep, those in the frames in it too, in the folder each runs
// in, which its tile then keeps; one at work, one that cannot resume, one another device runs and
// a shell are left, each with why; a name two tiles share is refused; a sleep that fails leaves its
// tile awake. Asleep, an agent keeps its name and what was sent it, and nothing is typed into it; a
// wake brings back the sleepers where they slept, rings what waited, and asks once more a wake
// given no answer; one whose saved session is gone is no longer kept asleep. Its conversation is
// not started again in another tile. Closed, a sleeper is ended where it sleeps. How sessions sleep and wake is the session layer's (sleep.test.ts).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_MANIFEST_VERSION, defFromManifest, setCatalog } from "@hivemind/agents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { Intents } from "@hivemind/workspace-host/intents";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import type { CoreLayout } from "@hivemind/workspace-doc/shapes";
import { NothingAsleep } from "@hivemind/agent-host/pty-protocol";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";

const caps = { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false } as const;
setCatalog([
  defFromManifest({ manifestVersion: AGENT_MANIFEST_VERSION, id: "acme", label: "Acme", bin: "acme", enabled: true, caps, session: { resume: { args: ["--resume", "{id}"], exists: "{home}/.acme/{id}.jsonl" } } }),
  defFromManifest({ manifestVersion: AGENT_MANIFEST_VERSION, id: "plain", label: "Plain", bin: "plain", caps }),
]);
after(() => setCatalog([]));

const REPO = "/work/api";
const layout: CoreLayout = {
  frames: [
    { id: "f1", title: "api", workspacePath: REPO },
    { id: "f3", title: "api-fix", worktreePath: `${REPO}-fix`, parentFrameId: "f1" },
    { id: "f2", title: "web", workspacePath: "ssh://me@box/web" },
  ],
  tiles: [
    { id: "a1", kind: "claude", label: "acme", cmd: "acme" },
    { id: "a2", kind: "claude", label: "acme", cmd: "acme" },
    { id: "a3", kind: "claude", label: "acme", cmd: "acme" },
    { id: "a4", kind: "claude", label: "acme", cmd: "acme" },
    { id: "a5", kind: "claude", label: "acme", cmd: "acme" },
    { id: "p1", kind: "claude", label: "plain", cmd: "plain" },
    { id: "x1", kind: "claude", label: "acme", cmd: "acme", session: "hm:elsewhere" },
    { id: "s1", kind: "shell", label: "sh", cmd: "/bin/bash" },
    { id: "e1", kind: "editor", label: "README" },
  ],
  tileNames: { a4: "reviewer", a5: "reviewer" },
  editorTabs: {},
  frameOf: { a1: "f1", a2: "f1", p1: "f1", x1: "f1", s1: "f1", e1: "f1", a3: "f3", a4: "f2", a5: "f2" },
};

function plane(o: { sleepFails?: Set<string>; noAnswer?: Set<string>; gone?: Set<string>; sessions?: Record<string, string>; asleep?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-sleep-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  // Asleep already: as the layout says after a restart.
  workspaces.setCore(REPO, { ...layout, tiles: layout.tiles.map((t) => (o.asleep?.[t.id] ? { ...t, sleeping: o.asleep[t.id] } : t)) });
  const running = new Set(["a1", "a2", "a3", "a4", "a5"].filter((t) => !o.asleep?.[t]).map((t) => `hm:${t}`));
  const writes: Array<{ to: string; data: string }> = [];
  const calls: string[] = [];
  const p = new ControlPlane({
    dir: () => dir,
    publish: () => {},
    spawned: () => {},
    windowsUp: () => false,
    // Nothing is typed into a session that is not running.
    write: (to, data) => { if (!running.has(to)) return false; writes.push({ to, data }); return true; },
    signalsTurns: () => true,
    methods: () => ({
      workspaces,
      shownWorkspace: () => null,
      launchOptions: () => ({}),
      endSession: (pty: string, folder?: string) => { calls.push(`end ${pty} ${folder ?? "-"}`); running.delete(pty); },
      sleepSession: async (pty: string, folder: string) => {
        calls.push(`sleep ${pty} ${folder}`);
        if (o.sleepFails?.has(pty)) throw new Error("its machine is not connected");
        running.delete(pty);
      },
      wakeSession: async (start: { ptyId: string; cwd: string }) => {
        calls.push(`wake ${start.ptyId} ${start.cwd}`);
        if (o.noAnswer?.delete(start.ptyId)) return { pid: -1 };
        if (o.gone?.has(start.ptyId)) throw new NothingAsleep(`nothing asleep as '${start.ptyId}'`);
        running.add(start.ptyId);
        return { pid: 42 };
      },
      sessionOf: (bare: string) => o.sessions?.[bare],
      sessionHeld: (pty: string) => running.has(pty),
      intents: new Intents(new AuditLog({ file: path.join(dir, "audit.jsonl") })),
      callRenderer: async () => { throw new Error("no window"); },
      reloadSettings: async () => ({}),
    }),
  } as unknown as ControlPlaneOptions);
  const asleepIn = (tile: string) => workspaces.getCore(REPO)?.tiles.find((t) => t.id === tile)?.sleeping;
  const typed = (tile: string) => writes.filter((w) => w.to === `hm:${tile}`).map((w) => w.data).join("");
  return { p, calls, asleepIn, typed, running };
}

const sorted = <T extends { slept?: string[]; woke?: string[]; skipped: Array<{ tile: string }> }>(r: T): T =>
  ({ ...r, ...(r.slept ? { slept: [...r.slept].sort() } : {}), ...(r.woke ? { woke: [...r.woke].sort() } : {}), skipped: [...r.skipped].sort((a, b) => a.tile.localeCompare(b.tile)) });

test("a frame's agents sleep in the folders they run in, those of the frames in it too; one at work, one that cannot resume, one run elsewhere and a shell are left, each with why", async () => {
  const { p, calls, asleepIn } = plane();
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  const api = await p.api();
  assert.deepEqual(sorted(await api.sleep(REPO, "api", false)), {
    slept: ["a1", "a3"],
    skipped: [
      { tile: "a2", why: "working: --force puts it to sleep anyway" },
      { tile: "p1", why: "Plain cannot resume its conversation: it would wake blank" },
      { tile: "s1", why: "not an agent: only an agent comes back where it was" },
      { tile: "x1", why: "it shows a session started elsewhere, which is theirs" },
    ],
  });
  assert.deepEqual(calls.sort(), [`sleep hm:a1 ${REPO}`, `sleep hm:a3 ${REPO}-fix`]);
  assert.equal(asleepIn("a1"), REPO);
  assert.equal(asleepIn("a3"), `${REPO}-fix`);
  assert.equal(asleepIn("a4"), undefined, "another frame's is left as it is");

  assert.deepEqual(await api.sleep(REPO, "a2", true), { slept: ["a2"], skipped: [] });
  assert.deepEqual(await api.sleep(REPO, "a1", false), { slept: [], skipped: [{ tile: "a1", why: "asleep already" }] });
});

test("a tile is named by its id or its name; a name two tiles share, and one nothing answers to, are refused", async () => {
  const { p } = plane();
  const api = await p.api();
  await assert.rejects(api.sleep(REPO, "reviewer", false), /2 tiles are called "reviewer": name one by its id/);
  await assert.rejects(api.sleep(REPO, "nobody", false), /no tile or frame here answers to "nobody"/);
  await assert.rejects(api.sleep("/work/other", undefined, false), /no such workspace here/);
  assert.deepEqual(await api.sleep(REPO, "hm:a4", false), { slept: ["a4"], skipped: [] });
});

test("a sleep that fails is asked once more, and then leaves its tile awake, saying why", async () => {
  const { p, calls, asleepIn } = plane({ sleepFails: new Set(["hm:a4"]) });
  const api = await p.api();
  assert.deepEqual(await api.sleep(REPO, "a4", false), { slept: [], skipped: [{ tile: "a4", why: "its machine is not connected" }] });
  assert.deepEqual(calls, ["sleep hm:a4 ssh://me@box/web", "sleep hm:a4 ssh://me@box/web"]);
  assert.equal(asleepIn("a4"), undefined);
});

test("asleep, an agent keeps its name and is not counted as ended; nothing is typed into it, and what was sent it is told once it is up again", async () => {
  const { p, typed } = plane();
  p.event("agent.event", { tileId: "hm:a1", event: "turn.started" });
  p.status.title("a1", "Fix the login");
  const api = await p.api();
  await api.sleep(REPO, "a1", true);
  await api.sleep(REPO, "a3", false);
  assert.deepEqual([p.status.get("a1")?.state, p.status.get("a1")?.title], ["interrupted", "Fix the login"]);

  assert.throws(() => api.send("a1", "next task"), /tile a1 is asleep: wake it first/);
  api.connect("a2", "a1");
  api.connect("a2", "a3");
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  p.event("agent.reply", { tileId: "hm:a2", text: "done" });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.ended" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([typed("a1"), typed("a3")], ["", ""], "nothing reaches a session that is not running");

  assert.deepEqual(sorted(await api.wake(REPO, undefined)), { woke: ["a1", "a3"], skipped: [] });
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual([typed("a1"), typed("a3")], ["", ""], "nothing is typed into an agent as it starts");
  await new Promise((r) => setTimeout(r, 1800));
  assert.match(typed("a3"), /hive ctl inbox/, "one that reports no turns is told once it has had a moment to start");
  assert.equal(typed("a1"), "", "one that reports its turns waits until it says it is up");
  p.event("agent.event", { tileId: "hm:a1", event: "session.started" });
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(typed("a1"), /hive ctl inbox/, "once it says it is up, it is told what came while it slept");
});

test("one asleep since before this host started is told, once woken, what was sent it meanwhile", async () => {
  const { p, typed } = plane({ asleep: { a5: "ssh://me@box/web" } });
  const api = await p.api();
  api.connect("a2", "a5");
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  p.event("agent.reply", { tileId: "hm:a2", text: "done" });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.ended" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(typed("a5"), "");
  assert.deepEqual(await api.wake(REPO, "a5"), { woke: ["a5"], skipped: [] });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(typed("a5"), "", "nothing is typed into an agent as it starts");
  await new Promise((r) => setTimeout(r, 2000));
  assert.match(typed("a5"), /hive ctl inbox/);
});

test("a wake brings back the workspace's sleepers where they slept and asks once more one given no answer; a tile named is woken whatever its layout says", async () => {
  const { p, calls, asleepIn } = plane({ noAnswer: new Set(["hm:a3"]) });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  const api = await p.api();
  await api.sleep(REPO, "api", false);
  calls.length = 0;
  assert.deepEqual(sorted(await api.wake(REPO, undefined)), { woke: ["a1", "a3"], skipped: [] });
  assert.deepEqual(calls.sort(), [`wake hm:a1 ${REPO}`, `wake hm:a3 ${REPO}-fix`, `wake hm:a3 ${REPO}-fix`]);
  assert.equal(asleepIn("a1"), undefined);
  assert.equal(asleepIn("a3"), undefined);

  calls.length = 0;
  assert.deepEqual(await api.wake(REPO, "a4"), { woke: ["a4"], skipped: [] });
  assert.deepEqual(calls, ["wake hm:a4 ssh://me@box/web"]);
});

test("one whose saved session is gone is no longer kept asleep: shown again, it starts afresh", async () => {
  const { p, asleepIn } = plane({ gone: new Set(["hm:a1"]) });
  const api = await p.api();
  await api.sleep(REPO, "a1", false);
  assert.deepEqual(await api.wake(REPO, undefined), { woke: [], skipped: [{ tile: "a1", why: "what it saved is gone: shown again, it starts afresh" }] });
  assert.equal(asleepIn("a1"), undefined);
});

test("a sleeper's conversation is not started again in another tile, however it is started, nor woken while another runs it", async () => {
  const conversation = "0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11";
  const { p } = plane({ sessions: { a1: conversation, a2: conversation } });
  const api = await p.api();
  await api.sleep(REPO, "a1", false);
  await assert.rejects(p.start(REPO, { program: "acme", resume: conversation }), /that conversation is asleep in tile a1: wake it instead/);
  // What every start asks, however its arguments name the conversation; its own tile's wake is not one.
  assert.equal(p.conversationAsleep("hm:n1", ["--resume", conversation]), "a1");
  assert.equal(p.conversationAsleep("hm:n1", [`--resume=${conversation}`]), "a1");
  assert.equal(p.conversationAsleep("hm:a1", ["--resume", conversation]), undefined);
  assert.equal(p.conversationAsleep("hm:n1", ["--resume", "6f1d0c2e-1111-4c55-9f43-2a8f6f2b9c11"]), undefined);
  assert.deepEqual(await api.wake(REPO, "a1"), { woke: [], skipped: [{ tile: "a1", why: "tile a2 runs this conversation now" }] });
});

test("a sleeper closed is ended where it sleeps", async () => {
  const { p, calls } = plane();
  const api = await p.api();
  await api.sleep(REPO, "a4", false);
  await p.close("a4");
  assert.deepEqual(calls.at(-1), "end hm:a4 ssh://me@box/web");
});
