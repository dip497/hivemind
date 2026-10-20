// Agents put to sleep and woken by the control plane (control/methods.ts, plane.ts), over a real
// workspace store: a frame's agents sleep, those in the frames in it too, in the folder each runs
// in, which its tile then keeps; one at work, one that cannot resume, one another device runs and
// a shell are left, each with why; a name two tiles share is refused; a sleep that fails leaves its
// tile awake. Asleep, an agent keeps its name and what was sent it, nothing is typed or keyed into
// it, and a read of its turn is answered that it is asleep. A wake brings back the sleepers where
// they slept, and a frame's one going to sleep once it has; it rings what waited, and asks once
// more a wake given no answer; one whose saved session is gone is no longer kept asleep. Its
// conversation is not started again in another tile. Closed, a sleeper is ended where it sleeps.
// How sessions sleep and wake is the session layer's (sleep.test.ts).
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

function plane(o: { slowSleep?: number; sleepFails?: Set<string>; noAnswer?: Set<string>; gone?: Set<string>; sessions?: Record<string, string>; asleep?: Record<string, string> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-sleep-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspaces = new WorkspaceStore({ dir, person: newSeed() });
  // Asleep already: as the layout says after a restart.
  workspaces.setCore(REPO, { ...layout, tiles: layout.tiles.map((t) => (o.asleep?.[t.id] ? { ...t, sleeping: o.asleep[t.id] } : t)) });
  const running = new Set(["a1", "a2", "a3", "a4", "a5"].filter((t) => !o.asleep?.[t]).map((t) => `hm:${t}`));
  const writes: Array<{ to: string; data: string }> = [];
  const calls: string[] = [];
  /** Settles a woken tile's screen. */
  const settled = new Map<string, () => void>();
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
        if (o.slowSleep) await new Promise((r) => setTimeout(r, o.slowSleep));
        if (o.sleepFails?.has(pty)) throw new Error("its machine is not connected");
        running.delete(pty);
      },
      wakeSession: async (start: { ptyId: string; cwd: string }) => {
        calls.push(`wake ${start.ptyId} ${start.cwd}`);
        if (o.noAnswer?.delete(start.ptyId)) return { pid: -1 };
        if (o.gone?.has(start.ptyId)) throw new NothingAsleep(`nothing asleep as '${start.ptyId}'`);
        running.add(start.ptyId);
        return { pid: 42, ready: new Promise<void>((r) => settled.set(start.ptyId.slice(3), r)) };
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
  const settle = (tile: string) => settled.get(tile)!();
  return { p, calls, asleepIn, typed, running, settle };
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
  assert.deepEqual(await api.sleep(REPO, "a1", false), { slept: [], skipped: [{ tile: "a1", why: "asleep already", already: true }] });
});

test("named nothing, every agent of the workspace sleeps, in every frame; a tile that runs nothing is not even listed", async () => {
  const { p, calls } = plane();
  p.event("agent.event", { tileId: "hm:a5", event: "turn.started" });
  const api = await p.api();
  assert.deepEqual(sorted(await api.sleep(REPO, undefined, false)), {
    slept: ["a1", "a2", "a3", "a4"],
    skipped: [
      { tile: "a5", why: "working: --force puts it to sleep anyway" },
      { tile: "p1", why: "Plain cannot resume its conversation: it would wake blank" },
      { tile: "s1", why: "not an agent: only an agent comes back where it was" },
      { tile: "x1", why: "it shows a session started elsewhere, which is theirs" },
    ],
  });
  assert.equal(calls.length, 4);
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
  const { p, typed, settle } = plane();
  p.event("agent.event", { tileId: "hm:a1", event: "turn.started" });
  p.status.title("a1", "Fix the login");
  const api = await p.api();
  api.connect("a2", "a1");
  api.connect("a2", "a3");
  await api.sleep(REPO, "a1", true);
  await api.sleep(REPO, "a3", false);
  assert.deepEqual([p.status.get("a1")?.state, p.status.get("a1")?.title], ["interrupted", "Fix the login"]);

  assert.throws(() => api.send("a1", "next task"), /tile a1 is asleep: wake it with hive ctl wake a1/);
  assert.throws(() => api.keys("a1", ["Enter"]), /tile a1 is asleep: wake it with hive ctl wake a1/);
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  p.event("agent.reply", { tileId: "hm:a2", text: "done" });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.ended" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([typed("a1"), typed("a3")], ["", ""], "nothing reaches a session that is not running");

  assert.deepEqual(sorted(await api.wake(REPO, undefined)), { woke: ["a1", "a3"], skipped: [] });
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepEqual([typed("a1"), typed("a3")], ["", ""], "nothing is typed into an agent as it starts");
  // a1 has reported turns, and says nothing as it starts.
  settle("a1");
  await new Promise((r) => setTimeout(r, 600));
  assert.match(typed("a1"), /hive ctl inbox/, "told once its screen has settled");
  assert.equal(typed("a3"), "");
  p.event("agent.event", { tileId: "hm:a3", event: "session.started" });
  await new Promise((r) => setTimeout(r, 2500));
  assert.match(typed("a3"), /hive ctl inbox/, "or once it says it is up, whichever comes first");
});

test("one woken that neither says it is up nor settles is told what waited after a minute", async (t) => {
  const { p, typed } = plane();
  const api = await p.api();
  api.connect("a2", "a3");
  await api.sleep(REPO, "a3", false);
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  p.event("agent.reply", { tileId: "hm:a2", text: "done" });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.ended" });
  await new Promise((r) => setTimeout(r, 300));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await api.wake(REPO, "a3");
  t.mock.timers.tick(59_000);
  assert.equal(typed("a3"), "");
  t.mock.timers.tick(1_000);
  t.mock.timers.tick(300);
  assert.match(typed("a3"), /hive ctl inbox/);
});

test("one asleep since before this host started is told, once woken and settled, what was sent it meanwhile", async () => {
  const { p, typed, settle } = plane({ asleep: { a5: "ssh://me@box/web" } });
  const api = await p.api();
  // A reply piped to it before the restart; no pipe to a sleeper is made now.
  p.inbox.post("a5", { from: "a2", name: "a2", kind: "reply", turn: 1, text: "done" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(typed("a5"), "");
  assert.deepEqual(await api.wake(REPO, "a5"), { woke: ["a5"], skipped: [] });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(typed("a5"), "", "nothing is typed into an agent as it starts");
  settle("a5");
  await new Promise((r) => setTimeout(r, 600));
  assert.match(typed("a5"), /hive ctl inbox/);
});

test("a wake brings back the workspace's sleepers where they slept and asks once more one given no answer; a tile named is woken whatever its layout says", async () => {
  const { p, calls, asleepIn, running } = plane({ noAnswer: new Set(["hm:a3"]) });
  p.event("agent.event", { tileId: "hm:a2", event: "turn.started" });
  const api = await p.api();
  await api.sleep(REPO, "api", false);
  calls.length = 0;
  assert.deepEqual(sorted(await api.wake(REPO, undefined)), { woke: ["a1", "a3"], skipped: [] });
  assert.deepEqual(calls.sort(), [`wake hm:a1 ${REPO}`, `wake hm:a3 ${REPO}-fix`, `wake hm:a3 ${REPO}-fix`]);
  assert.equal(asleepIn("a1"), undefined);
  assert.equal(asleepIn("a3"), undefined);

  calls.length = 0;
  running.delete("hm:a4"); // asleep where it runs, though its layout lost the mark
  assert.deepEqual(await api.wake(REPO, "a4"), { woke: ["a4"], skipped: [] });
  assert.deepEqual(calls, ["wake hm:a4 ssh://me@box/web"]);
});

test("a wake of a frame asked while one of its agents goes to sleep waits for that, then wakes it; one whose sleep failed is said to be awake", async () => {
  const { p, calls, asleepIn } = plane({ slowSleep: 200 });
  const api = await p.api();
  const sleeping = api.sleep(REPO, "a4", false);
  assert.deepEqual(await api.wake(REPO, "web"), { woke: ["a4"], skipped: [] });
  await sleeping;
  assert.deepEqual(calls, ["sleep hm:a4 ssh://me@box/web", "wake hm:a4 ssh://me@box/web"]);
  assert.equal(asleepIn("a4"), undefined);

  const failing = plane({ slowSleep: 200, sleepFails: new Set(["hm:a4"]) });
  const api2 = await failing.p.api();
  const failed = api2.sleep(REPO, "a4", false);
  assert.deepEqual(await api2.wake(REPO, "web"), { woke: [], skipped: [{ tile: "a4", why: "awake already", already: true }] });
  await failed;
  assert.deepEqual(failing.calls, ["sleep hm:a4 ssh://me@box/web", "sleep hm:a4 ssh://me@box/web"]);
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

test("a read of an agent's turn is refused at once that it is asleep, one already waiting as it is put to sleep too", async () => {
  const { p } = plane();
  const api = await p.api();
  const reading = api.read("a1", 10_000);
  await new Promise((r) => setTimeout(r, 50));
  await api.sleep(REPO, "a1", false);
  const started = Date.now();
  await assert.rejects(reading, { code: "ASLEEP", message: "tile a1 is asleep: wake it with hive ctl wake a1" });
  assert.ok(Date.now() - started < 1000, "not left to run out of time");
  await assert.rejects(api.read("a1", 10_000), { code: "ASLEEP" });
});

test("two sleepers of one frame in one conversation: one is woken, the other is not, while it runs it", async () => {
  const conversation = "0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11";
  const { p } = plane({ sessions: { a1: conversation, a3: conversation } });
  const api = await p.api();
  await api.sleep(REPO, "api", false);
  const r = await api.wake(REPO, "api");
  const first = r.woke.find((t) => t === "a1" || t === "a3")!;
  assert.deepEqual(r.woke.filter((t) => t !== first), ["a2"]);
  assert.deepEqual(r.skipped, [{ tile: first === "a1" ? "a3" : "a1", why: `tile ${first} runs this conversation now` }]);
});

test("put to sleep again in another conversation, a tile is asleep in that one", async () => {
  const sessions: Record<string, string> = { a1: "0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11" };
  const { p } = plane({ sessions });
  const api = await p.api();
  await api.sleep(REPO, "a1", false);
  assert.equal(p.conversationAsleep("hm:n1", ["--resume", sessions.a1!]), "a1");
  await api.wake(REPO, "a1");
  sessions.a1 = "6f1d0c2e-1111-4c55-9f43-2a8f6f2b9c22";
  await api.sleep(REPO, "a1", false);
  assert.equal(p.conversationAsleep("hm:n1", ["--resume", "0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11"]), undefined);
  assert.equal(p.conversationAsleep("hm:n1", ["--resume", sessions.a1]), "a1");
});

test("a sleeper closed is ended where it sleeps", async () => {
  const { p, calls } = plane();
  const api = await p.api();
  await api.sleep(REPO, "a4", false);
  await p.close("a4");
  assert.deepEqual(calls.at(-1), "end hm:a4 ssh://me@box/web");
});

/** The code a call failed with; "done" when it did not. */
const outcome = async (run: () => unknown): Promise<string> => {
  try { await run(); return "done"; } catch (e) { return (e as { code?: string }).code ?? String(e); }
};

test("every verb that needs its agent running is refused ASLEEP, saying the wake that fixes it: send, keys, read, a pipe from or to it, a report to it", async () => {
  const { p } = plane();
  const api = await p.api();
  const child = await p.start(REPO, { program: "acme", parent: "a1" });
  await api.sleep(REPO, "a1", true);
  const verbs: Array<[string, () => unknown]> = [
    ["send", () => api.send("a1", "next task")],
    ["keys", () => api.keys("a1", ["Enter"])],
    ["read", () => api.read("a1", 10_000)],
    ["connect from it", () => api.connect("a1", "a2")],
    ["connect to it", () => api.connect("a2", "a1")],
    ["report to it", () => p.agentChannel("agent.report", { message: "done" }, { actor: { kind: "tile", tile: child } } as never)],
  ];
  for (const [verb, run] of verbs) assert.deepEqual([verb, await outcome(run)], [verb, "ASLEEP"]);
  await assert.rejects(Promise.resolve().then(() => api.send("a1", "x")), /tile a1 is asleep: wake it with hive ctl wake a1/);
});

test("waking an agent that is awake answers awake already, as sleeping one asleep answers asleep already", async () => {
  const { p, calls } = plane();
  const api = await p.api();
  await api.sleep(REPO, "a1", true);
  assert.deepEqual(await api.sleep(REPO, "a1", true), { slept: [], skipped: [{ tile: "a1", why: "asleep already", already: true }] });
  assert.deepEqual(await api.wake(REPO, "a1"), { woke: ["a1"], skipped: [] });
  const wakes = calls.filter((c) => c.startsWith("wake")).length;
  assert.deepEqual(await api.wake(REPO, "a1"), { woke: [], skipped: [{ tile: "a1", why: "awake already", already: true }] });
  assert.equal(calls.filter((c) => c.startsWith("wake")).length, wakes, "nothing is started again");
});

test("an agent asking to put every agent to sleep is not put to sleep itself; named, it is", async () => {
  const { p, running } = plane();
  const api = await p.api();
  const r = await api.sleep(REPO, undefined, true, "a2");
  assert.ok(r.slept.includes("a1") && !r.slept.includes("a2"));
  assert.deepEqual([r.skipped.find((s) => s.tile === "a2")?.why, running.has("hm:a2")], ["it is the one asking: name it to put it to sleep", true]);
  assert.deepEqual((await api.sleep(REPO, "a2", true, "a2")).slept, ["a2"]);
});

test("a read after a wake does not hand back the reply from before the sleep, one never read either", async () => {
  const { p } = plane();
  const api = await p.api();
  assert.equal(api.send("a1", "echo piped"), true);
  await new Promise((r) => setTimeout(r, 600));
  p.event("agent.event", { tileId: "hm:a1", event: "turn.started" });
  p.event("agent.reply", { tileId: "hm:a1", text: "before the sleep" });
  p.event("agent.event", { tileId: "hm:a1", event: "turn.ended" });
  await api.sleep(REPO, "a1", false);
  await api.wake(REPO, "a1");
  const r = await api.read("a1", 0);
  assert.notEqual(r.text, "before the sleep");
  assert.equal(r.finalStatus, "idle");
});
