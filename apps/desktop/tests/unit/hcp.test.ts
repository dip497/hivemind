/** HCP core — protocol framing, transcript parse, turn tracker, recorder,
 *  method dispatch, and an end-to-end server round-trip (token + event). */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeLines, HCP_MAX_LINE } from "../../src/main/hcp/protocol.ts";
import { readLastAssistantMessage } from "../../src/main/hcp/transcript.ts";
import { TurnTracker } from "../../src/main/hcp/turn-tracker.ts";
import { OutputRecorder, stripAnsi } from "../../src/main/hcp/output-recorder.ts";
import { makeDispatch } from "../../src/main/hcp/methods.ts";
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

test("transcript: extracts the last assistant text block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx-"));
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    f,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FINAL answer" }] } }),
      "",
    ].join("\n"),
  );
  assert.equal(readLastAssistantMessage(f), "FINAL answer");
  assert.equal(readLastAssistantMessage(path.join(dir, "missing.jsonl")), null);
});

test("TurnTracker: waitForTurn resolves on next turn, times out otherwise", async () => {
  const tt = new TurnTracker();
  const epoch = tt.currentSeq("t1");
  const p = tt.waitForTurn("t1", epoch, 1000);
  tt.recordTurn("t1", "/tmp/x.jsonl");
  const rec = await p;
  assert.equal(rec?.transcriptPath, "/tmp/x.jsonl");
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
    writeToTile: write,
    deliverToTile: (id: string, data: string, onSent?: () => void) => mailbox.deliver(id, data, onSent),
    spawnAllowed: () => true,
    connect: () => true,
    disconnect: () => {},
    forgetPipes: () => {},
    spawnEdge: () => {},
    setSupervise: () => {},
    pushWait: () => {},
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

test("dispatch agent.read: returns transcript reply after a turn", async () => {
  const { deps, turns } = fakeDeps();
  const { dispatch } = makeDispatch(deps);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tx2-"));
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "the reply" }] } }));
  await dispatch("agent.send", { tileId: "t1", text: "go" });
  const read = dispatch("agent.read", { tileId: "t1", timeoutMs: 1000 });
  // The Stop hook records the turn under the PTY id (HIVEMIND_TILE = hm:<tileId>).
  turns.recordTurn("hm:t1", f);
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
  const banner = writes.find(([id, data]) => id === "hm:parent" && data.includes("hive_approve"));
  assert.ok(banner, "approval banner delivered to parent");
  const reqId = banner![1].match(/hive_approve\("([^"]+)"/)![1];
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
  const reqId = writes.find(([id, d]) => id === "hm:parent" && d.includes("hive_approve"))![1].match(/hive_approve\("([^"]+)"/)![1];
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

function rpc(sock: string, msg: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock, () => c.write(JSON.stringify(msg) + "\n"));
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = JSON.parse(line);
        if (m.t === "hello") continue; // skip greeting
        resolve(m); c.end();
      }
    });
    c.on("error", reject);
  });
}

test("hcp-server: token gate + dispatch + hook event", async () => {
  const sock = tmpSock();
  let evented: any = null;
  const srv = startHcpServer(sock, {
    token: "secret",
    rendererUp: () => true,
    dispatch: async (method, params) => ({ echoed: method, params }),
    onEvent: (topic, data) => { evented = { topic, data }; },
  });
  await new Promise((r) => setTimeout(r, 50));

  // Good token → res ok.
  const ok = await rpc(sock, { t: "req", id: "1", method: "x.y", params: { a: 1 }, token: "secret" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result, { echoed: "x.y", params: { a: 1 } });

  // Bad token → UNAUTHORIZED.
  const bad = await rpc(sock, { t: "req", id: "2", method: "x.y", token: "wrong" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "UNAUTHORIZED");

  // Hook event (no reply) reaches onEvent.
  await new Promise<void>((resolve) => {
    const c = net.connect(sock, () => { c.write(JSON.stringify({ t: "event", topic: "turn", data: { tileId: "t1" } }) + "\n"); c.end(); resolve(); });
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(evented, { topic: "turn", data: { tileId: "t1" } });
  srv.close();
});

test("hcp-server: agent.stream subscription receives broadcast chunks", async () => {
  const sock = tmpSock();
  const srv = startHcpServer(sock, {
    token: "secret",
    rendererUp: () => true,
    dispatch: async () => ({}),
    onEvent: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));

  const got: Array<{ seq: number; chunk: string }> = [];
  let acked = false;
  await new Promise<void>((resolve, reject) => {
    const c = net.connect(sock, () =>
      c.write(JSON.stringify({ t: "sub", id: "s1", topic: "agent.stream", params: { tileId: "t1" }, token: "secret" }) + "\n"),
    );
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        const m = JSON.parse(line);
        if (m.t === "hello") continue;
        if (m.t === "res" && m.id === "s1") {
          acked = m.ok === true;
          srv.broadcast("t2", "ignored"); // wrong tile — must NOT arrive
          srv.broadcast("t1", "hello ");
          srv.broadcast("t1", "world");
        }
        if (m.t === "evt" && m.subId === "s1") {
          got.push(m.data);
          if (got.length === 2) { c.end(); resolve(); }
        }
      }
    });
    c.on("error", reject);
  });

  assert.equal(acked, true);
  assert.deepEqual(got, [{ seq: 1, chunk: "hello " }, { seq: 2, chunk: "world" }]);
  srv.close();
});

test("recordTurn reports whether a blocking reader took the turn (auto-report dedup)", () => {
  const tt = new TurnTracker();
  // A parent's hive_read is blocked on the worker's next turn.
  const reader = tt.waitForTurn("hm:worker", tt.currentSeq("hm:worker"), 2000);
  // Worker finishes → the reader takes it, so the auto-report must stand down.
  assert.equal(tt.recordTurn("hm:worker", null, "reply"), true);
  // No one waiting → the auto-report is the delivery channel, so it must fire.
  assert.equal(tt.recordTurn("hm:lonely", null, "reply"), false);
  return reader; // settle the promise
});

test("single-delivery ladder: an explicit hive_report suppresses that turn's auto-report", () => {
  const tt = new TurnTracker();
  // Worker calls hive_report mid-turn (agent.report → markReported).
  tt.markReported("hm:worker");
  // Turn ends. recordTurn must report the reply was already delivered (by the explicit
  // report) so the auto-report banner stands down — no duplicate, no spurious turn.
  assert.equal(tt.recordTurn("hm:worker", null, "raw turn text"), true);
  // The flag is per-turn: a later turn with no explicit report auto-reports normally.
  assert.equal(tt.recordTurn("hm:worker", null, "next turn"), false);
});

test("forgetTile (pty-exit teardown) wakes a blocked hive_read instead of hanging it", async () => {
  const { deps } = fakeDeps();
  const { dispatch, forgetTile } = makeDispatch(deps);
  await dispatch("tile.spawn_agent", { agent: "claude", callerTile: "hm:tile-p" });
  const read = dispatch("agent.read", { tileId: "tile-x", timeoutMs: 60_000 });
  forgetTile("tile-x"); // worker's pty exits (crash) → teardown must resolve the read now
  const r = (await read) as { finalStatus: string };
  assert.equal(r.finalStatus, "timeout", "a crashed worker resolves the read immediately, doesn't hang 60s");
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
