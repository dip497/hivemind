/** HCP core — protocol framing, turn tracker, recorder,
 *  method dispatch, and an end-to-end server round-trip (token + event). */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeLines, HCP_MAX_LINE, HcpError } from "../../src/main/hcp/protocol.ts";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.ts";
import { OutputRecorder, stripAnsi } from "../../src/main/hcp/output-recorder.ts";
import { makeDispatch } from "../../src/main/hcp/methods.ts";
import { useAuthoredAgents } from "./authored-agents.ts";

// Spawn policy, supervise policy and prompt delivery read the live catalog: load the
// published fixtures the way an installed machine has them.
useAuthoredAgents();
import { startHcpServer } from "../../src/main/hcp/hcp-server.ts";
import { PipeManager } from "../../src/main/hcp/pipes.ts";
import { Mailbox } from "../../src/main/hcp/mailbox.ts";
import { SUBMIT_DELAY_MS } from "../../src/shared/agent-io.ts";

test("PipeManager: edges, self-loop refused, forget removes both directions", () => {
  const pm = new PipeManager();
  assert.equal(pm.connect("a", "a"), false); // self-loop
  assert.equal(pm.connect("a", "b"), true);
  pm.connect("a", "c");
  pm.connect("x", "a");
  assert.deepEqual(pm.dests("a").sort(), ["b", "c"]);
  pm.disconnect("a", "b");
  assert.deepEqual(pm.dests("a"), ["c"]);
  pm.forget("a"); // removes a→* AND *→a
  assert.deepEqual(pm.dests("a"), []);
  assert.deepEqual(pm.dests("x"), []);
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
  // (it holds them while the target is mid-turn), so the dispatch tests must too.
  // No tile is ever marked busy here, so it delivers straight through.
  const mailbox = new Mailbox(write, SUBMIT_DELAY_MS);
  const deps = {
    turns,
    recorder,
    callRenderer: async (_m: string, _p: unknown) => ({ tileId: "tile-x" }),
    reloadSettings: async () => ({ ok: true }),
    writeToTile: write,
    deliverToTile: (id: string, data: string, onSent?: () => void) => mailbox.deliver(id, data, onSent),
    spawnAllowed: () => true,
    // What main resolves from settings + PATH; the fixtures have claude.
    defaultAgentId: async () => "claude",
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    awaitingApproval: () => {},
    ...over,
  };
  return { deps, turns, recorder, writes };
}

test("dispatch agent.send: writes text + carriage return", async () => {
  const { deps, writes } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  const r = await dispatch("agent.send", { tileId: "t1", text: "hello" });
  assert.deepEqual(r, { ok: true });
  // Text is typed immediately; Enter follows as a SEPARATE keystroke a tick later
  // (claude's TUI drops a newline bundled with the text). Writes target the pty
  // id (`hm:<tileId>`), not the bare control-surface id.
  assert.deepEqual(writes, [["hm:t1", "hello"]]);
  await new Promise((res) => setTimeout(res, 130));
  assert.deepEqual(writes, [["hm:t1", "hello"], ["hm:t1", "\r"]]);
});

test("dispatch agent.read: returns the reply the agent's plugin reported for the turn", async () => {
  const { deps, turns } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  await dispatch("agent.send", { tileId: "t1", text: "go" });
  const read = dispatch("agent.read", { tileId: "t1", timeoutMs: 1000 });
  // The plugin reports under the PTY id (HIVEMIND_TILE = hm:<tileId>): the reply, then the turn.
  await dispatch("agent.reply", { tileId: "hm:t1", text: "the reply" });
  turns.recordTurn("hm:t1");
  assert.deepEqual(await read, { text: "the reply", finalStatus: "turn", truncated: false });
});

test("dispatch agent.send_keys: maps symbolic tokens to terminal bytes", async () => {
  const { deps, writes } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  const r = await dispatch("agent.send_keys", { tileId: "t1", keys: ["Down", "Enter"] });
  assert.deepEqual(r, { ok: true, keys: 2 });
  // First key writes immediately; the rest are staggered. Wait out the gap.
  await new Promise((res) => setTimeout(res, 120));
  assert.deepEqual(writes, [["hm:t1", "\x1b[B"], ["hm:t1", "\r"]]);
});

test("dispatch agent.send_keys: unknown tokens pass through as literal text", async () => {
  const { deps, writes } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  await dispatch("agent.send_keys", { tileId: "t1", keys: ["2"] });
  assert.deepEqual(writes, [["hm:t1", "2"]]);
});

test("approval: no parent → fail-safe ask (falls through to human prompt)", async () => {
  const { deps } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  const r = await dispatch("agent.await_approval", { callerTile: "orphan", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(r, { decision: "ask" });
});

test("approval: worker awaits, parent approves 'always' → allow + cached (no second round-trip)", async () => {
  const { deps, writes } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  // Spawn registers parentOf[tile-x] = parent (fake callRenderer returns tile-x).
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "parent", report: false });
  const pending = dispatch("agent.await_approval", { callerTile: "tile-x", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } });
  await new Promise((r) => setTimeout(r, 10));
  // The approval prompt is delivered into the PARENT's pty; pull the reqId out.
  const banner = writes.find(([id, data]) => id === "hm:parent" && data.includes("hive ctl approve"));
  assert.ok(banner, "approval banner delivered to parent");
  const reqId = banner![1].match(/hive ctl approve (\S+) /)![1];
  const ar = await dispatch("agent.approve", { reqId, decision: "always" });
  assert.deepEqual(ar, { ok: true, decision: "allow" });
  assert.equal((await pending as { decision: string }).decision, "allow");
  // Same worker+tool again → resolved from cache, no new banner to the parent.
  const before = writes.length;
  const r2 = await dispatch("agent.await_approval", { callerTile: "tile-x", tool_name: "Bash", tool_input: { command: "echo hi" } });
  assert.deepEqual(r2, { decision: "allow" });
  assert.equal(writes.length, before, "cached decision delivers no new approval prompt");
});

test("approval: deny carries a reason back to the worker", async () => {
  const { deps, writes } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "parent", report: false });
  const pending = dispatch("agent.await_approval", { callerTile: "tile-x", tool_name: "Write", tool_input: { file_path: "/etc/passwd" } });
  await new Promise((r) => setTimeout(r, 10));
  const reqId = writes.find(([id, d]) => id === "hm:parent" && d.includes("hive ctl approve"))![1].match(/hive ctl approve (\S+) /)![1];
  await dispatch("agent.approve", { reqId, decision: "deny", reason: "not that file" });
  assert.deepEqual(await pending, { decision: "deny", reason: "not that file" });
});

test("approval: stale/unknown reqId → BAD_REQUEST", async () => {
  const { deps } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  await assert.rejects(dispatch("agent.approve", { reqId: "nope", decision: "allow" }), (e: { code?: string }) => e.code === "BAD_REQUEST");
});

test("spawn supervise: records the broker policy (default set + 'all')", async () => {
  const supervised: Array<[string, string | null]> = [];
  const { deps } = fakeDeps({ setSupervise: (id: string, spec: string | null) => { supervised.push([id, spec]); } });
  const { dispatch } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "parent", supervise: true, report: false });
  assert.deepEqual(supervised.at(-1), ["tile-x", "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch"]);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "parent", supervise: "all", report: false });
  assert.deepEqual(supervised.at(-1), ["tile-x", "all"]);
});

test("tile-id: toPtyId / toBareId are idempotent inverses", async () => {
  const { toPtyId, toBareId } = await import("../../src/shared/tile-id.ts");
  assert.equal(toPtyId("tile-a"), "hm:tile-a");
  assert.equal(toPtyId("hm:tile-a"), "hm:tile-a"); // idempotent
  assert.equal(toBareId("hm:tile-a"), "tile-a");
  assert.equal(toBareId("tile-a"), "tile-a"); // idempotent
});

test("dispatch tile.spawn_agent: enforces MAX_SPAWN_DEPTH (anti-fork-bomb)", async () => {
  let n = 0;
  const { deps } = fakeDeps({ callRenderer: async () => ({ tileId: `t${++n}` }) });
  const { dispatch } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", {});                              // t1, depth 1 (user=0)
  await dispatch("tile.spawn_agent", { callerTile: "t1" });            // t2, depth 2
  await dispatch("tile.spawn_agent", { callerTile: "t2" });            // t3, depth 3
  await assert.rejects(                                                // depth 4 > 3
    dispatch("tile.spawn_agent", { callerTile: "t3" }),
    (e: unknown) => (e as { code?: string })?.code === "DEPTH_EXCEEDED",
  );
});

test("dispatch tile.spawn_agent: rate-limited → RATE_LIMITED", async () => {
  const { deps } = fakeDeps({ spawnAllowed: () => false });
  await assert.rejects(
    makeDispatch(deps).dispatch("tile.spawn_agent", { agent: "claude" }),
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
  const { dispatch, forgetTile } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-p" });
  const read = dispatch("agent.read", { tileId: "tile-x", timeoutMs: 60_000 });
  forgetTile("tile-x"); // worker's pty exits (crash) → teardown must resolve the read now
  const r = (await read) as { finalStatus: string };
  assert.equal(r.finalStatus, "closed", "a crashed worker resolves the read immediately (and says it closed, not that it is still working)");
});

test("forgetTile resolves a supervised worker's pending approval (deny), not leak it", async () => {
  const { deps } = fakeDeps();
  const { dispatch, forgetTile } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", { agent: "claude", supervise: true, callerTile: "hm:tile-p" });
  const approval = dispatch("agent.await_approval", { callerTile: "hm:tile-x", tool_name: "Bash", tool_input: { command: "ls" } });
  forgetTile("tile-x"); // worker crashed mid-approval
  const r = (await approval) as { decision: string };
  assert.equal(r.decision, "deny", "a crashed worker's approval resolves deny, doesn't hang 20 min");
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

test("dispatch views.rescan: asks the renderer to re-read the view packages and returns its registry", async () => {
  const calls: string[] = [];
  const { deps } = fakeDeps({ callRenderer: async (m: string) => { calls.push(m); return { registered: ["orbit"], refused: { greedy: "unknown permission" } }; } });
  const { dispatch } = makeDispatch(deps);
  assert.deepEqual(await dispatch("views.rescan", {}), { registered: ["orbit"], refused: { greedy: "unknown permission" } });
  assert.deepEqual(calls, ["views.rescan"]);
});

test("tool.open: optional tools default off and recheck activation for every request", async () => {
  let enabled = false;
  let calls = 0;
  const { deps } = fakeDeps({
    toolsSettings: () => ({ enabledPlugins: enabled ? ["hivemind/web"] : [], disabledTools: [] }),
    callRenderer: async (method, params) => { calls++; assert.equal(method, "tool.open"); assert.deepEqual(params, { tool: "hivemind/web/browser", frame: undefined, url: "about:blank" }); return { tileId: "browser-1" }; },
  });
  const { dispatch } = makeDispatch(deps);
  const request = { tool: "hivemind/web/browser", url: "about:blank" };
  await assert.rejects(dispatch("tool.open", request), { code: "UNAUTHORIZED" });
  enabled = true;
  assert.deepEqual(await dispatch("tool.open", request), { tileId: "browser-1" });
  enabled = false;
  await assert.rejects(dispatch("tool.open", request), { code: "UNAUTHORIZED" });
  assert.equal(calls, 1);
});

test("tool.open: unknown tools, disabled contributions, invalid URLs and spawn floods are refused", async () => {
  let disabledTools: string[] = [];
  let spawn = true;
  const { deps } = fakeDeps({
    toolsSettings: () => ({ enabledPlugins: ["hivemind/web"], disabledTools }),
    spawnAllowed: () => spawn,
    callRenderer: async () => { assert.fail("denied request reached renderer"); },
  });
  const { dispatch } = makeDispatch(deps);
  await assert.rejects(dispatch("tool.open", { tool: "unknown/browser" }), { code: "UNSUPPORTED" });
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "broken", 123]) {
    await assert.rejects(dispatch("tool.open", { tool: "hivemind/web/browser", url }), { code: "BAD_REQUEST" });
  }
  disabledTools = ["hivemind/web/browser"];
  await assert.rejects(dispatch("tool.open", { tool: "hivemind/web/browser" }), { code: "UNAUTHORIZED" });
  disabledTools = []; spawn = false;
  await assert.rejects(dispatch("tool.open", { tool: "hivemind/web/browser" }), { code: "RATE_LIMITED" });
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

test("hcp-server: nothing before initialize with the token; then methods, and our error codes in data", async () => {
  const sock = tmpSock();
  const srv = startHcpServer(sock, {
    token: "secret", rendererUp: () => true, onEvent: () => {},
    dispatch: async (method, params) => { if (method === "boom") throw new HcpError("TILE_NOT_FOUND", "no such tile"); return { echoed: method, params }; },
  });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  assert.equal((await s.call("x.y")).error.data.code, "UNAUTHORIZED", "nothing before initialize");
  assert.equal((await s.call("initialize", { token: "wrong" })).error.code, -32000);
  assert.deepEqual((await s.call("initialize", { token: "secret" })).result, { protocolVersion: 2, rendererUp: true, capabilities: { status: false } });
  assert.deepEqual((await s.call("x.y", { a: 1 })).result, { echoed: "x.y", params: { a: 1 } });
  assert.deepEqual((await s.call("boom")).error, { code: -32000, message: "no such tile", data: { code: "TILE_NOT_FOUND" } });
  s.close();
  srv.close();
});

test("hcp-server: a hook's agent.event needs no token; any other unauthenticated notification is dropped", async () => {
  const sock = tmpSock();
  const got: unknown[] = [];
  const srv = startHcpServer(sock, { token: "secret", rendererUp: () => true, dispatch: async () => ({}), onEvent: (m, p) => { got.push([m, p]); } });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  s.notify("agent.event", { tileId: "hm:t1", event: "turn.ended" });
  s.notify("agent.reply", { tileId: "hm:t1", text: "forged" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, [["agent.event", { tileId: "hm:t1", event: "turn.ended" }]]);
  s.close();
  srv.close();
});

test("hcp-server: agent.stream/subscribe replays what the recorder holds, then live chunks for that tile only", async () => {
  const sock = tmpSock();
  const rec = new OutputRecorder();
  rec.record("t", "a\nb\n");
  const srv = startHcpServer(sock, {
    token: "k", rendererUp: () => true, onEvent() {}, dispatch: async () => ({}),
    replay: (id, o) => (typeof o.lines === "number" ? rec.tail(id, o.lines) : rec.since(id, o.since ?? 0)),
    offsetOf: (id) => rec.mark(id),
  });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  await s.call("initialize", { token: "k" });
  const sub = await s.call("agent.stream/subscribe", { tileId: "t", lines: 1 });
  assert.equal(sub.result.offset, 4);
  const subscriptionId = sub.result.subscriptionId;
  srv.broadcast("other", "ignored");
  srv.broadcast("t", "c\n");
  await s.until((l) => l.method === "agent.stream" && l.params.seq === 1);
  assert.deepEqual(s.notes("agent.stream").map((n) => n.params), [
    { subscriptionId, seq: 0, chunk: "b\n", offset: 4, replay: true },
    { subscriptionId, seq: 1, chunk: "c\n", offset: 4 },
  ]);
  await s.call("agent.stream/unsubscribe", { subscriptionId });
  srv.broadcast("t", "d\n");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.notes("agent.stream").length, 2);
  s.close();
  srv.close();
});

test("hcp-server: status/subscribe — the whole picture without a cursor, only what changed with one, then live", async () => {
  const { StatusStore } = await import("@hivemind/agent-host/status-store");
  const store = new StatusStore();
  store.event("hm:a", { event: "turn.started" });
  const sock = tmpSock();
  const srv = startHcpServer(sock, { token: "k", rendererUp: () => true, onEvent: () => {}, dispatch: async () => ({}), status: store });
  await new Promise((r) => setTimeout(r, 50));
  const s = await session(sock);
  await s.call("initialize", { token: "k" });
  const first = await s.call("status/subscribe", {});
  assert.equal(first.result.cursor, 1);
  assert.equal(first.result.snapshot[0].status.state, "working");
  store.event("hm:a", { event: "turn.ended" });
  await s.until((l) => l.method === "status/changed");
  assert.deepEqual(s.notes("status/changed")[0].params, { seq: 2, tileId: "hm:a", status: store.get("hm:a") });
  const resumed = await s.call("status/subscribe", { since: 1 });
  assert.deepEqual(resumed.result.changes.map((ch: any) => ch.seq), [2]);
  s.close();
  srv.close();
});
