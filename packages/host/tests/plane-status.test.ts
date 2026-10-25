// What the control plane hears of an agent is its status: a daemon's reading of its screen
// (`agent.screen`) until its hooks speak, a wait and what screen it says it is; and the session its
// hooks say it is in (`agent.event`); and what a tile's screen last showed (`tile.line`), or its
// agent last said, read again as it reports.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evictTrackedSession, readTrackedSession, TILE_SESSIONS_DIR } from "@hivemind/agents/node";
import net from "node:net";
import { readOrCreateToken, tileToken } from "@hivemind/agent-host/hooks/token";
import { ControlPlane, type ControlPlaneOptions } from "../src/control/plane.ts";
import { TileLines } from "../src/tile-lines.ts";

const plane = (o: Partial<ControlPlaneOptions> = {}) => new ControlPlane({
  dir: () => "/nowhere",
  publish: () => {},
  write: () => true,
  spawned: () => {},
  methods: () => { throw new Error("no methods here"); },
  windowsUp: () => false,
  ...o,
} as unknown as ControlPlaneOptions);

test("a screen reading is the agent's status, with what screen it says; one that says it as anything but text says nothing", () => {
  const p = plane();
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: "trust" });
  const at = () => { const s = p.status.get("t1")!; return { state: s.state, kind: s.kind, says: s.says }; };
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: "trust" });
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: 7 });
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: undefined });
  p.event("agent.screen", { tileId: "hm:t1", state: "nonsense", says: "trust" });
  assert.deepEqual(at(), { state: "waiting", kind: "permission", says: undefined }, "a state not read from a screen is no reading");
});

test("the session an agent's hooks say it is in is its status's; one that says none keeps it", () => {
  const p = plane();
  p.event("agent.event", { tileId: "hm:t1", event: "session.started", sessionId: "5f0c3a1e" });
  assert.equal(p.status.get("t1")?.session, "5f0c3a1e");
  p.event("agent.event", { tileId: "hm:t1", event: "turn.started" });
  assert.equal(p.status.get("t1")?.session, "5f0c3a1e");
});

test("what a tile's screen last showed is its line, by its bare id, and told; anything but text is no line, and a tile forgotten keeps none", () => {
  let told = 0;
  const lines = new TileLines({ server: () => ({ publishTo: () => {} }), changed: () => told++ });
  const p = plane({ lines });
  p.event("tile.line", { tileId: "hm:t1", line: "building" });
  assert.equal(lines.get("t1"), "building");
  assert.equal(told, 1);
  p.event("tile.line", { tileId: "hm:t1", line: 7 });
  p.event("tile.line", { line: "nobody's" });
  assert.equal(lines.get("t1"), "building");
  assert.equal(told, 1);
  p.forget("hm:t1");
  assert.equal(lines.get("t1"), undefined);
});

test("an agent's report (a hook's event, a reply passed on from another machine) moves its tile's line to what it said since, while someone follows the tile", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hm-plane-lines-"));
  try {
    const file = path.join(dir, "s1.jsonl");
    let n = 0;
    const words = (text: string) => fs.appendFileSync(file, `${JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content: text } })}\n`);
    const lines = new TileLines({
      server: () => ({ publishTo: () => {} }),
      transcriptOf: (bare) => (bare === "t1" ? { session: "s1", file, format: { id: "uuid", at: "timestamp", said: [{ require: { type: "assistant" }, text: "message.content", who: "agent" }] } } : null),
    });
    lines.followAll(true);
    const p = plane({ lines });
    const until = async (line: string) => { for (let i = 0; i < 100 && lines.get("t1") !== line; i++) await new Promise((r) => setTimeout(r, 10)); };
    words("Starting");
    assert.deepEqual(await lines.read(["t1"]), { t1: "Starting" });
    words("Reading the code");
    p.event("agent.event", { tileId: "hm:t1", event: "input.resolved" });
    await until("Reading the code");
    assert.equal(lines.get("t1"), "Reading the code");
    words("214 tests pass");
    p.event("agent.reply", { tileId: "hm:t1", text: "214 tests pass" });
    await until("214 tests pass");
    assert.equal(lines.get("t1"), "214 tests pass");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a startup screen answered (a folder's trust) does not hold the messages sent after it", async () => {
  const wrote: string[] = [];
  const p = plane({ signalsTurns: () => true, write: (_pty: string, data: string) => { wrote.push(data); return true; } });
  p.event("agent.screen", { tileId: "hm:t1", state: "permission", says: "trust" });
  p.event("agent.screen", { tileId: "hm:t1", state: "working" });
  p.mailbox.deliver("hm:t1", "hello");
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(wrote.some((d) => d.includes("hello")), "the message is typed, not held for a turn that never ends");
  p.mailbox.forget("hm:t1");
});

test("the session an agent's hooks name is recorded for its tile to resume: a new one replaces it, and after its session ends and its file is gone, the same one is recorded again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-sessions-"));
  try {
    const p = plane({ dir: () => dir });
    const kept = () => readTrackedSession(path.join(dir, TILE_SESSIONS_DIR), "hm:t1");
    p.event("agent.event", { tileId: "hm:t1", event: "session.started", sessionId: "s1" });
    p.event("agent.event", { tileId: "hm:t1", event: "turn.started", sessionId: "s1" });
    assert.equal(kept(), "s1");
    p.event("agent.event", { tileId: "hm:t1", event: "session.started", sessionId: "s2" });
    assert.equal(kept(), "s2");
    // Its daemon ends the session and takes its file; the tile resumes the same session.
    p.event("agent.event", { tileId: "hm:t1", event: "session.ended", sessionId: "s2" });
    p.status.exited("t1");
    evictTrackedSession(path.join(dir, TILE_SESSIONS_DIR), "hm:t1");
    p.event("agent.event", { tileId: "hm:t1", event: "session.started", sessionId: "s2" });
    assert.equal(kept(), "s2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("on the control-plane socket nothing is heard before a connection signs in, and a tile speaks for itself: what it says of another tile is dropped, what it says of its own is heard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plane-sock-"));
  const lines = new TileLines({ server: () => ({ publishTo: () => {} }) });
  const p = plane({ dir: () => dir, lines });
  const sock = path.join(dir, "hcp.sock");
  const server = p.listen(sock);
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 10));
  try {
    const line = (m: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`;
    // Said on a connection of its own, which ends once the host has read it.
    const said = async (...m: Array<Record<string, unknown>>) => {
      const c = net.connect(sock);
      c.on("data", () => {});
      await new Promise((r) => c.once("connect", r));
      c.end(m.map(line).join(""));
      await new Promise((r) => c.once("close", r));
    };
    const as = (tile: string) => ({ id: "init", method: "initialize", params: { token: tileToken(readOrCreateToken(dir), tile) } });
    await said({ method: "agent.event", params: { tileId: "hm:t1", event: "turn.started" } }, { method: "tile.line", params: { tileId: "hm:t1", line: "unsigned" } });
    await said(as("hm:t2"),
      { method: "agent.event", params: { tileId: "hm:t1", event: "turn.started" } },
      { method: "tile.line", params: { tileId: "hm:t1", line: "forged" } },
      { method: "agent.screen", params: { tileId: "t1", state: "permission" } },
      { method: "tile.line", params: { tileId: "hm:t2", line: "its own" } });
    assert.equal(lines.get("t2"), "its own");
    assert.equal(lines.get("t1"), undefined);
    assert.equal(p.status.get("t1"), undefined);
    await said(as("hm:t1"), { method: "agent.event", params: { tileId: "hm:t1", event: "turn.started" } });
    assert.equal(p.status.get("t1")?.state, "working");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
