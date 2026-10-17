/** The control plane — protocol framing, turn tracker, recorder, its work and the agent
 *  channel, and an end-to-end server round-trip (token + event). */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeLines, HCP_MAX_LINE } from "@hivemind/host/control/protocol";
import { ApiError } from "@hivemind/workspace-api/protocol";
import { TurnTracker } from "@hivemind/host/control/turn-tracker";
import { OutputRecorder, stripAnsi } from "@hivemind/host/control/output-recorder";
import { makeDispatch } from "@hivemind/host/control/methods";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn policy, supervise policy and prompt delivery read the live catalog: load the
// published fixtures the way an installed machine has them.
useAuthoredAgents();
import { startHcpServer } from "@hivemind/host/control/hcp-server";
import { PipeManager } from "@hivemind/host/control/pipes";
import { Mailbox } from "@hivemind/host/control/mailbox";
import { Inbox } from "@hivemind/host/control/inbox";
import { SUBMIT_DELAY_MS } from "@hivemind/agent-host/agent-io";
import { WorkspaceStore } from "@hivemind/workspace-host/store";
import { newSeed } from "@hivemind/workspace-host/identity";
import { REPO, workspaceDeps, PERSON, fromTile } from "./hcp-workspace.ts";

test("PipeManager: edges, self-loop refused, forget removes both directions", () => {
  const pm = new PipeManager();
  assert.equal(pm.connect("a", "a"), false); // self-loop
  assert.equal(pm.connect("a", "b"), true);
  pm.connect("a", "c");
  pm.connect("x", "a");
  assert.deepEqual(pm.dests("a").sort(), ["b", "c"]);
  // Every pipe, for a window that opens after they were drawn.
  assert.deepEqual(pm.edges().sort(), [["a", "b"], ["a", "c"], ["x", "a"]]);
  pm.disconnect("a", "b");
  assert.deepEqual(pm.dests("a"), ["c"]);
  pm.forget("a"); // removes a→* AND *→a
  assert.deepEqual(pm.dests("a"), []);
  assert.deepEqual(pm.dests("x"), []);
  assert.deepEqual(pm.edges(), []);
});

test("PipeManager: refuses cycles (direct + transitive)", () => {
  const pm = new PipeManager();
  assert.equal(pm.connect("a", "b"), true);
  assert.equal(pm.connect("b", "a"), false); // direct 2-cycle a→b→a
  assert.equal(pm.connect("b", "c"), true);
  assert.equal(pm.connect("c", "a"), false); // transitive cycle a→b→c→a
  assert.deepEqual(pm.dests("b").sort(), ["c"]);
});

test("takeLines: splits complete lines, keeps remainder, rejects overlong", () => {
  const { lines, rest } = takeLines("a\nbb\ncc");
  assert.deepEqual(lines, ["a", "bb"]);
  assert.equal(rest, "cc");
  assert.throws(() => takeLines("x".repeat(HCP_MAX_LINE + 1)));
});

test("TurnTracker: waitForTurn resolves on next turn, times out otherwise", async () => {
  const tt = new TurnTracker();
  const epoch = tt.currentSeq("t1");
  const p = tt.waitForTurn("t1", epoch, 1000);
  tt.recordReply("t1", "the reply");
  tt.recordTurn("t1");
  const rec = await p;
  assert.equal(rec?.text, "the reply");
  // A reply belongs to one turn: the next turn without one carries none.
  tt.recordTurn("t1");
  assert.equal((await tt.waitForTurn("t1", rec!.seq, 10))?.text, null);
  // Already-past turn resolves immediately.
  assert.ok(await tt.waitForTurn("t1", -1, 1000));
  // No turn → timeout → null.
  assert.equal(await tt.waitForTurn("t1", tt.currentSeq("t1"), 60), null);
});

test("OutputRecorder: strips ANSI and returns the delta since a mark", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m text"), "red text");
  const r = new OutputRecorder();
  r.record("t", "hello ");
  const mark = r.mark("t");
  r.record("t", "\x1b[1mworld\x1b[0m");
  assert.equal(r.since("t", mark), "world");
});

function fakeDeps(over: Partial<Parameters<typeof makeDispatch>[0]> = {}) {
  const turns = new TurnTracker();
  const recorder = new OutputRecorder();
  const writes: Array<[string, string]> = [];
  const write = (id: string, data: string) => { writes.push([id, data]); return true; };
  // The REAL mailbox, not a stub — messages to an agent go through it in production
  // (it holds them while the target is mid-turn), so these tests must too.
  // No tile is ever marked busy here, so it delivers straight through.
  const mailbox = new Mailbox(write, SUBMIT_DELAY_MS);
  const deps = {
    turns,
    recorder,
    callRenderer: async () => { throw new Error("no window"); },
    reloadSettings: async () => ({ ok: true }),
    writeToTile: write,
    deliverToTile: (id: string, data: string, onSent?: () => void) => mailbox.deliver(id, data, onSent),
    inbox: new Inbox((to, wanted, rung) => mailbox.deliver(`hm:${to}`, "[hive] inbox", rung, { wanted, atPrompt: true })),
    waitingOf: () => undefined,
    spawnAllowed: () => true,
    // What main resolves from settings + PATH; the fixtures have claude.
    defaultAgentId: async () => "claude",
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    ...workspaceDeps(),
    ...over,
  };
  return { deps, turns, recorder, writes };
}

test("send: writes text + carriage return", async () => {
  const { deps, writes } = fakeDeps();
  const { api } = makeDispatch(deps);
  assert.equal(api.send("t1", "hello"), true);
  // Text is typed immediately; Enter follows as a SEPARATE keystroke a tick later
  // (claude's TUI drops a newline bundled with the text). Writes target the pty
  // id (`hm:<tileId>`), not the bare control-surface id.
  assert.deepEqual(writes, [["hm:t1", "hello"]]);
  await new Promise((res) => setTimeout(res, 130));
  assert.deepEqual(writes, [["hm:t1", "hello"], ["hm:t1", "\r"]]);
});

test("output: the last lines a tile printed, escapes taken out; a tile open nowhere is NOT_FOUND", () => {
  const { deps, recorder } = fakeDeps({ sessionHeld: (pid: string) => pid === "hm:t1" });
  const { api } = makeDispatch(deps);
  recorder.record("hm:t1", "one\n\x1b[31mtwo\x1b[0m\nthree\n");
  assert.deepEqual(api.output("t1", 2), { text: "two\nthree\n" });
  assert.deepEqual(api.output("hm:t1"), { text: "one\ntwo\nthree\n" });
  assert.throws(() => api.output("t2"), { code: "NOT_FOUND" });
});

test("read: returns the reply the agent's plugin reported for the turn", async () => {
  const { deps, turns } = fakeDeps({ sessionHeld: (id) => id === "hm:t1" });
  const { api, agentChannel } = makeDispatch(deps);
  api.send("t1", "go");
  const read = api.read("t1", 1000);
  // The plugin reports under the PTY id (HIVEMIND_TILE = hm:<tileId>): the reply, then the turn.
  await agentChannel("agent.reply", { tileId: "hm:t1", text: "the reply" }, PERSON);
  turns.recordTurn("hm:t1");
  assert.deepEqual(await read, { text: "the reply", finalStatus: "turn", truncated: false });
});

test("read after a send waits for the turn the send causes, not one that ended before it", async () => {
  const { deps, turns } = fakeDeps();
  const { api, spawn } = makeDispatch(deps);
  const worker = await spawn({ agent: "claude", repo: REPO });
  turns.recordReply(`hm:${worker}`, "the first task, done");
  turns.recordTurn(`hm:${worker}`); // nobody read it
  api.send(worker, "now the second");
  const read = api.read(worker, 1000);
  turns.recordReply(`hm:${worker}`, "the second, done");
  turns.recordTurn(`hm:${worker}`);
  assert.equal((await read).text, "the second, done");
});

test("read: a tile nothing knows of is not found at once; one opened but not yet running is waited on", async () => {
  const { deps } = fakeDeps();
  deps.workspaces.addTile(REPO, { id: "tile-new", kind: "claude", label: "claude #1" });
  const { api } = makeDispatch(deps);
  const started = Date.now();
  await assert.rejects(api.read("tile-gone", 5_000), (e: unknown) => e instanceof ApiError && e.code === "NOT_FOUND");
  assert.ok(Date.now() - started < 1_000, "answered at once, not at the timeout");
  assert.deepEqual(await api.read("tile-new", 50), { text: null, finalStatus: "timeout", truncated: false, note: "agent still working — no completed turn within timeout" });
});

test("keys: maps symbolic tokens to terminal bytes", async () => {
  const { deps, writes } = fakeDeps();
  const { api } = makeDispatch(deps);
  assert.equal(api.keys("t1", ["Down", "Enter"]), 2);
  // First key writes immediately; the rest are staggered. Wait out the gap.
  await new Promise((res) => setTimeout(res, 120));
  assert.deepEqual(writes, [["hm:t1", "\x1b[B"], ["hm:t1", "\r"]]);
});

test("keys: unknown tokens pass through as literal text", () => {
  const { deps, writes } = fakeDeps();
  const { api } = makeDispatch(deps);
  api.keys("t1", ["2"]);
  assert.deepEqual(writes, [["hm:t1", "2"]]);
});

test("approval: no parent → fail-safe ask (falls through to human prompt)", async () => {
  const { deps } = fakeDeps();
  const { agentChannel } = makeDispatch(deps);
  const r = await agentChannel("agent.await_approval", { callerTile: "orphan", tool_name: "Bash", tool_input: { command: "ls" } }, PERSON);
  assert.deepEqual(r, { decision: "ask" });
});

/** Answer the approval the banner names, as `hive ctl approve` does (agent.answer). */
function approve(deps: ReturnType<typeof fakeDeps>["deps"], reqId: string, decision: "allow" | "deny", o: { always?: boolean; feedback?: string } = {}) {
  const wait = deps.waits.named(reqId);
  assert.ok(wait, `${reqId} waits`);
  return deps.waits.answer(wait!.tile, wait!.since, decision, o);
}

/** The approval `parent` was asked last, from its inbox. */
const askedOf = (deps: ReturnType<typeof fakeDeps>["deps"], parent: string): string =>
  deps.inbox.take(parent).messages.filter((m) => m.kind === "approval").at(-1)!.text.match(/hive ctl approve (\S+) /)![1]!;

test("approval: worker awaits, parent approves 'always' → allow + cached (no second round-trip)", async () => {
  const { deps, writes } = fakeDeps();
  const { agentChannel, spawn } = makeDispatch(deps);
  // The spawn makes `parent` the worker's parent.
  const worker = await spawn({ agent: "claude", parent: "parent", report: false, repo: REPO });
  const pending = agentChannel("agent.await_approval", { callerTile: worker, tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }, PERSON);
  await new Promise((r) => setTimeout(r, 10));
  // The question waits in the PARENT's inbox; pull the reqId out.
  const reqId = askedOf(deps, "parent");
  assert.deepEqual(approve(deps, reqId, "allow", { always: true }), { answered: true });
  assert.equal((await pending as { decision: string }).decision, "allow");
  // Same worker+tool again → resolved from cache, nothing new for the parent.
  const before = writes.length;
  const r2 = await agentChannel("agent.await_approval", { callerTile: worker, tool_name: "Bash", tool_input: { command: "echo hi" } }, PERSON);
  assert.deepEqual(r2, { decision: "allow" });
  assert.equal(writes.length, before, "cached decision tells the parent nothing");
  assert.deepEqual(deps.inbox.take("parent").messages, []);
});

test("approval: deny carries a reason back to the worker", async () => {
  const { deps, writes } = fakeDeps();
  const { agentChannel, spawn } = makeDispatch(deps);
  const worker = await spawn({ agent: "claude", parent: "parent", report: false, repo: REPO });
  const pending = agentChannel("agent.await_approval", { callerTile: worker, tool_name: "Write", tool_input: { file_path: "/etc/passwd" } }, PERSON);
  await new Promise((r) => setTimeout(r, 10));
  const reqId = askedOf(deps, "parent");
  approve(deps, reqId, "deny", { feedback: "not that file" });
  assert.deepEqual(await pending, { decision: "deny", reason: "not that file" });
});

test("spawn supervise: records the broker policy (default set + 'all')", async () => {
  const { deps } = fakeDeps();
  const { spawn } = makeDispatch(deps);
  const first = await spawn({ agent: "claude", parent: "parent", supervise: true, report: false, repo: REPO });
  assert.equal(deps.spawnRecords.get(first)?.supervise, "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch");
  const second = await spawn({ agent: "claude", parent: "parent", supervise: "all", report: false, repo: REPO });
  assert.equal(deps.spawnRecords.get(second)?.supervise, "all");
});

test("the agent channel carries what an agent's plugin and hooks say, and nothing else: the rest is the workspace API's", async () => {
  const { deps, writes } = fakeDeps();
  const { agentChannel } = makeDispatch(deps);
  for (const method of ["tile.spawn_agent", "agent.send", "agent.send_keys", "agent.read", "agent.output", "agent.approve", "agent.sessions", "tile.list", "tile.list_frames",
    "tile.close", "tile.rename", "tile.focus", "tile.connect", "tool.open", "workflow.run", "agent.list", "host.status", "host.people", "host.join", "settings.reload"]) {
    await assert.rejects(agentChannel(method, {}, PERSON), { code: "UNKNOWN_METHOD" }, method);
    await assert.rejects(agentChannel(method, {}, fromTile("t1")), { code: "UNKNOWN_METHOD" }, method);
  }
  assert.deepEqual(writes, [], "nothing was typed anywhere");
  assert.deepEqual(deps.workspaces.getCore(REPO)?.tiles, [], "nothing was opened");
});

test("tile-id: toPtyId / toBareId are idempotent inverses", async () => {
  const { toPtyId, toBareId } = await import("@hivemind/workspace-api/tile-id");
  assert.equal(toPtyId("tile-a"), "hm:tile-a");
  assert.equal(toPtyId("hm:tile-a"), "hm:tile-a"); // idempotent
  assert.equal(toBareId("hm:tile-a"), "tile-a");
  assert.equal(toBareId("tile-a"), "tile-a"); // idempotent
});

test("spawn: enforces MAX_SPAWN_DEPTH (anti-fork-bomb)", async () => {
  const { deps } = fakeDeps();
  const { spawn } = makeDispatch(deps);
  const t1 = await spawn({ repo: REPO });                 // depth 1 (user=0)
  const t2 = await spawn({ parent: t1, repo: REPO });     // depth 2
  const t3 = await spawn({ parent: t2, repo: REPO });     // depth 3
  await assert.rejects(                                   // depth 4 > 3
    spawn({ parent: t3, repo: REPO }),
    (e: unknown) => (e as { code?: string })?.code === "DEPTH_EXCEEDED",
  );
});

test("spawn writes the tile in main: in the frame named, else beside its caller, else the first, else loose; the windows hear of it first", async () => {
  const ws = workspaceDeps();
  ws.workspaces.setCore(REPO, {
    frames: [{ id: "f1", title: "repo", workspacePath: REPO }, { id: "f2", title: "Notes" }],
    tiles: [{ id: "tile-lead", kind: "claude", label: "claude #1" }],
    frameOf: { "tile-lead": "f1" },
  });
  const heardFirst: boolean[] = [];
  const { deps } = fakeDeps({
    ...ws,
    shownWorkspace: () => ({ repo: REPO, frame: "f2" }),
    launchOptions: (id) => (id === "claude" ? { model: "opus" } : {}),
    announceSpawn: (spawn) => { ws.announced.push(spawn); heardFirst.push(ws.workspaces.workspaceOf(spawn.tileId) === null); },
  });
  const made = makeDispatch(deps);
  const spawn = (p: { parent?: string; prompt?: string; report?: boolean; frame?: string }) => made.spawn({ agent: "claude", repo: REPO, ...p });
  const tileOf = (id: string) => ws.workspaces.getCore(REPO)!.tiles.find((t) => t.id === id);
  const frameOf = (id: string) => ws.workspaces.getCore(REPO)!.frameOf?.[id];

  const worker = await spawn({ parent: "tile-lead", prompt: "Review the auth module. Then fix it.", report: false });
  assert.deepEqual(tileOf(worker), { id: worker, kind: "claude", label: "claude #2", cmd: "claude", args: ["--dangerously-skip-permissions", "--model", "opus"], task: "Review the auth module" });
  assert.equal(frameOf(worker), "f1", "beside the agent that spawned it");
  assert.deepEqual(ws.announced.at(-1), { tileId: worker, repo: REPO, prompt: "Review the auth module. Then fix it.", background: true, near: "tile-lead" });
  assert.equal(frameOf(await spawn({})), "f1", "a caller in no tile: the workspace's first frame");
  assert.equal(frameOf(await spawn({ parent: "tile-lead", frame: "NOTES" })), "f2", "a frame named any way spawn takes");
  assert.equal(ws.announced.at(-1)?.near, undefined, "laid out beside its caller only in the caller's frame");
  await assert.rejects(spawn({ frame: "nothing" }), (e: unknown) => e instanceof ApiError && e.code === "NOT_FOUND");
  assert.equal(ws.workspaces.getCore(REPO)!.tiles.length, 4, "a refused spawn opens nothing");
  assert.deepEqual(heardFirst, [true, true, true], "the windows hear of each tile before it is written");

  ws.workspaces.setCore("/bare", { frames: [], tiles: [] });
  const loose = await made.spawn({ agent: "claude", repo: "/bare" });
  assert.deepEqual(ws.workspaces.getCore("/bare")?.frameOf, {}, "a workspace with no frame: loose, for the window to frame");
  assert.ok(ws.workspaces.getCore("/bare")?.tiles.some((t) => t.id === loose));
});

test("spawn: rate-limited → RATE_LIMITED", async () => {
  const { deps } = fakeDeps({ spawnAllowed: () => false });
  await assert.rejects(
    makeDispatch(deps).spawn({ agent: "claude", repo: REPO }),
    (e: unknown) => (e as { code?: string })?.code === "RATE_LIMITED",
  );
});

const tmpSock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hcp-")), "hcp.sock");

test("recordTurn reports whether a blocking reader took the turn (auto-report dedup)", () => {
  const tt = new TurnTracker();
  // A parent's hive_read is blocked on the worker's next turn.
  const reader = tt.waitForTurn("hm:worker", tt.currentSeq("hm:worker"), 2000);
  // Worker finishes → the reader takes it, so the auto-report must stand down.
  assert.equal(tt.recordTurn("hm:worker", "reply"), true);
  // No one waiting → the auto-report is the delivery channel, so it must fire.
  assert.equal(tt.recordTurn("hm:lonely", "reply"), false);
  return reader; // settle the promise
});

test("single-delivery ladder: an explicit hive_report suppresses that turn's auto-report", () => {
  const tt = new TurnTracker();
  // Worker calls hive_report mid-turn (agent.report → markReported).
  tt.markReported("hm:worker");
  // Turn ends. recordTurn must report the reply was already delivered (by the explicit
  // report) so the auto-report banner stands down — no duplicate, no spurious turn.
  assert.equal(tt.recordTurn("hm:worker", "raw turn text"), true);
  // The flag is per-turn: a later turn with no explicit report auto-reports normally.
  assert.equal(tt.recordTurn("hm:worker", "next turn"), false);
});

test("forgetTile (pty-exit teardown) wakes a blocked hive_read instead of hanging it", async () => {
  const { deps } = fakeDeps();
  const { api, spawn, forgetTile } = makeDispatch(deps);
  const worker = await spawn({ agent: "claude", parent: "tile-p", repo: REPO });
  const read = api.read(worker, 60_000);
  forgetTile(worker); // worker's pty exits (crash) → teardown must resolve the read now
  const r = (await read) as { finalStatus: string };
  assert.equal(r.finalStatus, "closed", "a crashed worker resolves the read immediately (and says it closed, not that it is still working)");
});

test("forgetTile resolves a supervised worker's pending approval (deny), not leak it", async () => {
  const { deps } = fakeDeps();
  const { agentChannel, spawn, forgetTile } = makeDispatch(deps);
  const worker = await spawn({ agent: "claude", supervise: true, parent: "tile-p", repo: REPO });
  const approval = agentChannel("agent.await_approval", { callerTile: `hm:${worker}`, tool_name: "Bash", tool_input: { command: "ls" } }, PERSON);
  forgetTile(worker); // worker crashed mid-approval
  const r = (await approval) as { decision: string };
  assert.equal(r.decision, "deny", "a crashed worker's approval resolves deny, doesn't hang 20 min");
});

test("close needs no window: the tile leaves its workspace, and the session it runs ends, not one it adopted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcp-close-"));
  const store = new WorkspaceStore({ dir, person: newSeed() });
  store.setCore("/w", { frames: [], tiles: [
    { id: "tile-a", kind: "claude", label: "a" },
    { id: "tile-s", kind: "shell", label: "s", session: "hive-run-1" }, // `hive run`'s session, shown here
    { id: "tile-e", kind: "editor", label: "e" },
  ] });
  const ended: string[] = [];
  const { deps } = fakeDeps({
    callRenderer: async () => { throw new Error("no window"); },
    workspaces: store,
    endSession: (ptyId) => void ended.push(ptyId),
  });
  const { api, close } = makeDispatch(deps);
  const read = api.read("tile-a", 5_000);
  for (const tileId of ["hm:tile-a", "tile-s", "tile-e"]) assert.deepEqual(await close(tileId), { ok: true });
  assert.deepEqual(ended, ["hm:tile-a"]);
  assert.deepEqual(store.getCore("/w")?.tiles, []);
  assert.equal(((await read) as { finalStatus: string }).finalStatus, "closed", "a read waiting on it is answered at once");
  await assert.rejects(close("tile-a"), (e: unknown) => e instanceof ApiError && e.code === "NOT_FOUND");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("OutputRecorder: lazy trim still never returns more than the ring cap, and since() is exact after overshoot", () => {
  const rec = new OutputRecorder();
  const CAP = 256 * 1024;
  const chunk = "a".repeat(64 * 1024);
  for (let i = 0; i < 7; i++) rec.record("t", chunk); // 448 KB → overshoots the cap, then trims
  const m = rec.mark("t");
  rec.record("t", "TAIL");
  assert.equal(rec.since("t", m), "TAIL");
  assert.equal(rec.since("t", 0).length, CAP, "reads are bounded by the cap");
  assert.ok(rec.since("t", 0).endsWith("TAIL"));
});

test("OutputRecorder.tail: last N ANSI-stripped lines, trailing newline not a line", () => {
  const rec = new OutputRecorder();
  rec.record("t", "one\n\x1b[31mtwo\x1b[0m\nthree\n");
  assert.equal(rec.tail("t", 2), "two\nthree\n");
  assert.equal(rec.tail("t", 10), "one\ntwo\nthree\n");
  assert.equal(rec.tail("t", 0), "");
  assert.equal(rec.tail("none", 3), "");
  rec.record("t", "four"); // partial line counts once
  assert.equal(rec.tail("t", 1), "four");
});

test("rescan views: asks the renderer to re-read the view packages and returns its registry", async () => {
  const calls: string[] = [];
  const { deps } = fakeDeps({ callRenderer: async (m: string) => { calls.push(m); return { registered: ["orbit"], refused: { greedy: "unknown permission" } }; } });
  const { api } = makeDispatch(deps);
  assert.deepEqual(await api.rescan("views"), { registered: ["orbit"], refused: { greedy: "unknown permission" } });
  assert.deepEqual(calls, ["views.rescan"]);
});

test("tool.open: optional tools default off and recheck activation for every request", async () => {
  let enabled = false;
  const { deps } = fakeDeps({ toolsSettings: () => ({ enabledPlugins: enabled ? ["hivemind/web"] : [], disabledTools: [] }) });
  const { api } = makeDispatch(deps);
  const open = () => api.openTool(undefined, REPO, "hivemind/web/browser", { url: "about:blank" });
  await assert.rejects(open(), { code: "FORBIDDEN" });
  enabled = true;
  const tileId = await open();
  enabled = false;
  await assert.rejects(open(), { code: "FORBIDDEN" });
  assert.deepEqual(deps.workspaces.getCore(REPO)?.tiles, [{ id: tileId, kind: "browser", label: "Browser #1", url: "about:blank" }]);
});

test("tool.open: unknown tools, disabled contributions, invalid URLs and spawn floods are refused", async () => {
  let disabledTools: string[] = [];
  let spawn = true;
  const { deps } = fakeDeps({
    toolsSettings: () => ({ enabledPlugins: ["hivemind/web"], disabledTools }),
    spawnAllowed: () => spawn,
  });
  const { api } = makeDispatch(deps);
  const open = (tool: string, url?: unknown) => api.openTool(undefined, REPO, tool, { url });
  await assert.rejects(open("unknown/browser"), { code: "UNSUPPORTED" });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "broken", 123]) {
    await assert.rejects(open("hivemind/web/browser", url), { code: "BAD_REQUEST" });
  }
  disabledTools = ["hivemind/web/browser"];
  await assert.rejects(open("hivemind/web/browser"), { code: "FORBIDDEN" });
  disabledTools = []; spawn = false;
  await assert.rejects(open("hivemind/web/browser"), { code: "RATE_LIMITED" });
  assert.deepEqual(deps.workspaces.getCore(REPO)?.tiles, [], "no refused request opened a tile");
});

/** One JSON-RPC connection: `call` waits for its reply; notifications collect in `notes`. */
async function session(sock: string) {
  const c = net.connect(sock);
  const lines: any[] = [];
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (d: string) => { buf += d; let nl; while ((nl = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
  await new Promise((r) => c.once("connect", r));
  let n = 0;
  const until = async (pred: (l: any) => boolean) => {
    for (let i = 0; i < 200 && !lines.some(pred); i++) await new Promise((r) => setTimeout(r, 10));
    return lines.find(pred);
  };
  return {
    call: async (method: string, params?: unknown) => {
      const id = ++n;
      c.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return until((l) => l.id === id);
    },
    notify: (method: string, params?: unknown) => c.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    notes: (method: string) => lines.filter((l) => l.method === method),
    until,
    close: () => c.destroy(),
  };
}

/** Tokens a test server knows: "secret" is the person's, "t1-token" the agent's in tile t1. */
const knownTokens = (t: unknown) => (t === "secret" ? PERSON.actor : t === "t1-token" ? fromTile("t1").actor : null);

test("hcp-server: nothing before initialize with a token it knows; then methods, made by whoever the token names, and our error codes in data", async () => {
  const sock = tmpSock();
  const srv = startHcpServer(sock, {
    authenticate: knownTokens, rendererUp: () => true, onEvent: () => {},
    dispatch: async (method, params, call) => { if (method === "boom") throw new ApiError("NOT_FOUND", "no such tile"); return { echoed: method, params, by: call.actor }; },
  });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  assert.equal((await s.call("x.y")).error.data.code, "FORBIDDEN", "nothing before initialize");
  assert.equal((await s.call("initialize", { token: "wrong" })).error.code, -32000);
  assert.equal((await s.call("x.y")).error.data.code, "FORBIDDEN", "nor after a token it does not know");
  assert.deepEqual((await s.call("initialize", { token: "secret" })).result, { protocolVersion: 2, rendererUp: true });
  assert.deepEqual((await s.call("x.y", { a: 1 })).result, { echoed: "x.y", params: { a: 1 }, by: { kind: "person" } });
  assert.deepEqual((await s.call("boom")).error, { code: -32000, message: "no such tile", data: { code: "NOT_FOUND" } });
  const agent = await session(sock);
  await agent.call("initialize", { token: "t1-token" });
  assert.deepEqual((await agent.call("x.y")).result.by, { kind: "tile", tile: "t1" });
  s.close();
  agent.close();
  srv.close();
});

test("hcp-server: a call still running when its caller goes is told that nobody waits for it any more", async () => {
  const sock = tmpSock();
  let told = false;
  const srv = startHcpServer(sock, {
    authenticate: knownTokens, rendererUp: () => true, onEvent: () => {},
    dispatch: (_method, _params, call) => new Promise((resolve) => call.signal?.addEventListener("abort", () => { told = true; resolve(null); })),
  });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  await s.call("initialize", { token: "t1-token" });
  void s.call("agent.await_approval", { tool_name: "Bash" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(told, false, "not while it waits");
  s.close();
  for (let i = 0; i < 100 && !told; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(told, true);
  srv.close();
});

test("hcp-server: nothing said before initialize is heard, a hook's agent.event too; once signed in it is heard with who said it", async () => {
  const sock = tmpSock();
  const got: unknown[] = [];
  const srv = startHcpServer(sock, { authenticate: knownTokens, rendererUp: () => true, dispatch: async () => ({}), onEvent: (m, p, from) => { got.push([m, p, from]); } });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  s.notify("agent.event", { tileId: "hm:t1", event: "turn.started" });
  s.notify("agent.reply", { tileId: "hm:t1", text: "forged" });
  await s.call("initialize", { token: "t1-token" });
  s.notify("agent.event", { tileId: "hm:t1", event: "turn.ended" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [["agent.event", { tileId: "hm:t1", event: "turn.ended" }, fromTile("t1").actor]]);
  s.close();
  srv.close();
});
