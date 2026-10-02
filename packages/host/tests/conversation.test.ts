// What an agent and the person said to each other (conversation.ts, conversations.ts,
// spec/agents.md "Conversation"): an agent's session file read, as its manifest maps it, from its
// end or after a cursor, whole lines only; followed as it is written; served to whoever asks, then
// each piece written to them alone, and the next session's once the agent begins one, until they
// go; and found as the agent's manifest says it keeps it, for the session its tracker last
// recorded. How a mapping reads records is packages/hive-agents' (transcript.test.ts).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setCatalog, TILE_SESSIONS_DIR, writeTrackedSession, type AgentProviderDef, type AgentTranscript } from "@hivemind/agents/node";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { followConversation, readConversation, TAIL_BYTES, TAIL_ENTRIES } from "../src/conversation.ts";
import { conversations, transcriptOf, type Transcript } from "../src/conversations.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-conversation-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let made = 0;

/** How the session files here say what was said: each record a prompt of the person's. */
const FORMAT: AgentTranscript = { id: "uuid", at: "timestamp", said: [{ require: { type: "user" }, text: "message.content", who: "person" }] };
/** A record of the person's: its line. */
const said = (n: number, text = `prompt ${n}`) =>
  `${JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: new Date(1_790_000_000_000 + n).toISOString(), message: { role: "user", content: text } })}\n`;
const sessionFile = (body: string) => {
  const at = path.join(tmp, `session-${made++}.jsonl`);
  fs.writeFileSync(at, body);
  return at;
};

test("from its end the file is read whole lines only, the last 200 entries of its last 1 MiB; after a cursor, only what came after it; a line not yet ended waits", () => {
  const lines = Array.from({ length: 300 }, (_, n) => said(n)).join("");
  const at = sessionFile(`${lines}${said(300).slice(0, 20)}`);
  const first = readConversation(at, FORMAT);
  assert.equal(first.entries.length, TAIL_ENTRIES);
  assert.deepEqual([first.entries[0]!.id, first.entries.at(-1)!.id], ["u100", "u299"]);
  assert.equal(first.cursor, Buffer.byteLength(lines), "the cursor stops at the end of the last whole line");
  fs.appendFileSync(at, `${said(300).slice(20)}${said(301)}`);
  assert.deepEqual(readConversation(at, FORMAT, first.cursor).entries.map((e) => e.id), ["u300", "u301"]);
  // A file longer than 1 MiB is read from inside it: the piece of a line it begins in is no record,
  // even one that reads as one.
  const last = said(1);
  const inside = said(9, "");
  const fake = inside.replace('"content":""', `"content":"${"z".repeat(TAIL_BYTES - Buffer.byteLength(inside) - Buffer.byteLength(last))}"`).trimEnd();
  const big = sessionFile(`not a record ${fake}\n${last}`);
  assert.equal(fs.statSync(big).size - TAIL_BYTES, Buffer.byteLength("not a record "), "the read begins where the fake record does");
  assert.deepEqual(readConversation(big, FORMAT).entries.map((e) => e.id), ["u1"]);
  assert.deepEqual(readConversation(path.join(tmp, "none.jsonl"), FORMAT), { entries: [], cursor: 0 });
});

test("followed, what is written next is handed on as it comes, a line once it ends, until it is stopped", async () => {
  const at = sessionFile(said(0));
  const heard: Array<{ ids: string[]; cursor: number }> = [];
  const stop = followConversation(at, FORMAT, readConversation(at, FORMAT).cursor, (s) => heard.push({ ids: s.entries.map((e) => e.id), cursor: s.cursor }));
  fs.appendFileSync(at, said(1));
  fs.appendFileSync(at, said(2).slice(0, 10));
  for (let t = 0; t < 3000 && heard.length === 0; t += 20) await wait(20);
  await wait(100);
  assert.deepEqual(heard.map((h) => h.ids), [["u1"]]);
  fs.appendFileSync(at, said(2).slice(10));
  for (let t = 0; t < 3000 && heard.length === 1; t += 20) await wait(20);
  assert.deepEqual(heard.map((h) => h.ids), [["u1"], ["u2"]]);
  assert.equal(heard[1]!.cursor, fs.statSync(at).size);
  stop();
  fs.appendFileSync(at, said(3));
  await wait(1500);
  assert.equal(heard.length, 2, "nothing once stopped");
});

/** A server of conversations, the agent of `t1` keeping the session `kept()` says, and how to
 *  connect a caller to it. */
function served(kept: () => Transcript | null) {
  const server = new WorkspaceServer([conversations({ transcriptOf: (tile) => (tile === "t1" ? kept() : null) })], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = () => {
    const closing = new AbortController();
    const got: EventMessage[] = [];
    const c: Connection & { got: EventMessage[]; go(): void } = { actor: { kind: "person" }, got, send: (m) => got.push(m), closed: closing.signal, go: () => closing.abort() };
    server.connect(c);
    return c;
  };
  return { server, client };
}
const ids = (answer: unknown) => ((answer as { result?: { entries: Array<{ id: string }> } }).result?.entries ?? []).map((e) => e.id);

test("asked for an agent's conversation, the caller is answered what it says so far, in which session, and then sent each piece written, alone, until it goes; an agent with no session file says nothing", async () => {
  const at = sessionFile(said(0) + said(1));
  const { server, client } = served(() => ({ session: "s1", file: at, format: FORMAT }));
  const [phone, other] = [client(), client()];
  try {
    const answer = await server.answer("agent.conversation", ["hm:t1"], phone);
    assert.ok("result" in answer);
    const first = answer.result as { entries: Array<{ id: string }>; cursor: number; session: string };
    assert.deepEqual([ids(answer), first.session], [["u0", "u1"], "s1"]);
    fs.appendFileSync(at, said(2));
    for (let t = 0; t < 3000 && phone.got.length === 0; t += 20) await wait(20);
    assert.deepEqual(phone.got, [{ event: "agent.said", params: ["t1", [{ id: "u2", at: 1_790_000_000_002, who: "person", text: "prompt 2" }], fs.statSync(at).size, "s1"] }]);
    assert.deepEqual(other.got, [], "only the caller is sent it");
    phone.go();
    fs.appendFileSync(at, said(3));
    await wait(1500);
    assert.equal(phone.got.length, 1, "nothing once it goes");
    // From a cursor in its session, only what came after it; a cursor in another session, or none,
    // counts for nothing.
    assert.deepEqual(ids(await server.answer("agent.conversation", ["t1", first.cursor, "s1"], other)), ["u2", "u3"]);
    assert.deepEqual(ids(await server.answer("agent.conversation", ["t1", first.cursor, "s0"], other)), ["u0", "u1", "u2", "u3"]);
    assert.deepEqual(ids(await server.answer("agent.conversation", ["t1", first.cursor], other)), ["u0", "u1", "u2", "u3"]);
    assert.deepEqual(await server.answer("agent.conversation", ["t7"], other), { result: { entries: [], cursor: 0 } });
    assert.equal(((await server.answer("agent.conversation", ["t1", -1], other)) as { error: { code: string } }).error.code, "BAD_REQUEST");
    assert.equal(((await server.answer("agent.conversation", ["t1", 0, 7], other)) as { error: { code: string } }).error.code, "BAD_REQUEST");
  } finally {
    phone.go();
    other.go();
  }
});

test("followed, an agent that begins another session (Claude Code's /clear) is followed in it: the last of it, then what is written to it, each named by it; the one before says no more", async () => {
  const before = sessionFile(said(0));
  let kept: Transcript | null = { session: "s1", file: before, format: FORMAT };
  const { server, client } = served(() => kept);
  const phone = client();
  try {
    assert.deepEqual(ids(await server.answer("agent.conversation", ["t1"], phone)), ["u0"]);
    // Begun, its file not yet written, there is none to find: still the one before.
    kept = null;
    await wait(1500);
    assert.deepEqual(phone.got, []);
    const after = sessionFile(said(5));
    kept = { session: "s2", file: after, format: FORMAT };
    for (let t = 0; t < 4000 && phone.got.length === 0; t += 20) await wait(20);
    assert.deepEqual(phone.got.map((e) => e.params), [["t1", [{ id: "u5", at: 1_790_000_000_005, who: "person", text: "prompt 5" }], fs.statSync(after).size, "s2"]]);
    fs.appendFileSync(before, said(1));
    fs.appendFileSync(after, said(6));
    for (let t = 0; t < 3000 && phone.got.length === 1; t += 20) await wait(20);
    await wait(1200);
    assert.deepEqual(phone.got.map((e) => [ids({ result: { entries: e.params[1] } }), e.params[3]]), [[["u5"], "s2"], [["u6"], "s2"]]);
  } finally {
    phone.go();
  }
});

test("an agent's session is the one last recorded for its tile, else the one bound as it started, its file where its manifest says, read as its manifest maps it; none when the manifest maps no transcript, or the file is not there", () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const sessions = path.join(tmp, `tile-sessions-${made++}`);
  const project = path.join(home, ".claude", "projects", "-home-p-api");
  fs.mkdirSync(project, { recursive: true });
  for (const id of ["s-bound", "s-tracked"]) fs.writeFileSync(path.join(project, `${id}.jsonl`), said(0));
  // Its manifest names no tracker: what the daemon recorded as it bound the session counts all the
  // same.
  const claude = {
    id: "claude", label: "Claude Code", bin: "claude", enabled: true,
    session: { transcript: FORMAT, resume: { args: ["--resume", "{id}"], from: { bound: "--session-id" }, exists: "{home}/.claude/projects/*/{id}.jsonl" } },
  } as unknown as AgentProviderDef;
  const plain = { ...claude, id: "plain", bin: "plain", session: { ...claude.session, transcript: undefined } } as unknown as AgentProviderDef;
  setCatalog([claude, plain]);
  const held = [{ workspace: "w", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [
    { id: "t1", kind: "claude", label: "Claude", cmd: "claude", args: ["--session-id", "s-bound"] },
    { id: "t2", kind: "plain", label: "Plain", cmd: "plain", args: ["--session-id", "s-bound"] },
  ] } }] as never;
  assert.deepEqual(transcriptOf(held, "hm:t1", sessions, home), { session: "s-bound", file: path.join(project, "s-bound.jsonl"), format: FORMAT });
  writeTrackedSession(sessions, "hm:t1", "s-tracked");
  assert.deepEqual(transcriptOf(held, "t1", sessions, home), { session: "s-tracked", file: path.join(project, "s-tracked.jsonl"), format: FORMAT });
  assert.equal(transcriptOf(held, "t2", sessions, home), null);
  assert.equal(transcriptOf(held, "t9", sessions, home), null);
  writeTrackedSession(sessions, "hm:t1", "s-gone");
  assert.equal(transcriptOf(held, "t1", sessions, home), null, "a session whose file is not there");
  assert.equal(TILE_SESSIONS_DIR, "tile-sessions");
});
