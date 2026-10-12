// What an agent and the person said to each other (conversation.ts, conversations.ts,
// spec/agents.md "Conversation"): an agent's session file read, as its manifest maps it, from its
// end or after a cursor, whole lines only; followed as it is written; served to whoever asks, then
// each piece written to them alone, and the next session's once the agent begins one, until they
// go; and found as the agent's manifest says it keeps it, for the session its tracker last
// recorded; one tool use unfolded, as conformance/conversation.json's `unfolded` cases say. How a
// mapping reads records is packages/hive-agents' (transcript.test.ts).
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
import { readAgentManifest } from "@hivemind/agents/load";
import { followConversation, lastSaid, pendingTool, readConversation, TAIL_BYTES, TAIL_ENTRIES, TOOL_MAX, toolUse } from "../src/conversation.ts";
import { conversations, LastSaid, transcriptOf, type Transcript } from "../src/conversations.ts";

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

test("the tool use an agent waits on is the first since it last said anything that nothing was given back for: what it is about whole (to 4000 characters), the questions it asks; none once it says something after it", () => {
  const TOOLS: AgentTranscript = {
    id: "uuid", at: "timestamp",
    said: [
      { require: { type: "assistant" }, each: "message.content", item: { type: "text" }, text: "text", who: "agent" },
      { require: { type: "assistant" }, each: "message.content", item: { type: "tool_use" }, tool: { id: "id", name: "name", about: ["input.command"], asks: { list: "input.questions", question: "question", options: "options", label: "label" } } },
      { require: { type: "user" }, each: "message.content", item: { type: "tool_result" }, result: { of: "tool_use_id", text: "content" } },
    ],
  };
  let n = 0;
  const record = (type: string, ...content: object[]) =>
    `${JSON.stringify({ type, uuid: `r${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content } })}\n`;
  const command = `cat <<EOF > notes.md\n${"a long line ".repeat(20)}\nEOF`;
  const at = sessionFile([
    record("assistant", { type: "tool_use", id: "old", name: "Bash", input: { command: "ls" } }),
    record("assistant", { type: "text", text: "Listing done; now writing." }),
    record("assistant", { type: "tool_use", id: "t1", name: "Read", input: {} }),
    record("user", { type: "tool_result", tool_use_id: "t1", content: "read" }),
    record("assistant", { type: "tool_use", id: "t2", name: "Bash", input: { command } }, { type: "tool_use", id: "t3", name: "Bash", input: { command: "make" } }),
  ].join(""));
  assert.deepEqual(pendingTool(at, TOOLS), { name: "Bash", about: command });
  fs.appendFileSync(at, record("user", { type: "tool_result", tool_use_id: "t2", content: "" }));
  assert.deepEqual(pendingTool(at, TOOLS), { name: "Bash", about: "make" });
  fs.appendFileSync(at, record("assistant", { type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "Which color?", options: [{ label: "Red" }, { label: "Blue" }] }] } }));
  fs.appendFileSync(at, record("user", { type: "tool_result", tool_use_id: "t3", content: "" }));
  assert.deepEqual(pendingTool(at, TOOLS), { name: "AskUserQuestion", asks: [{ question: "Which color?", options: ["Red", "Blue"] }] });
  fs.appendFileSync(at, record("assistant", { type: "text", text: "Blue it is." }));
  assert.equal(pendingTool(at, TOOLS), undefined);
  const huge = "x".repeat(4001);
  fs.appendFileSync(at, record("assistant", { type: "tool_use", id: "big", name: "Bash", input: { command: huge } }));
  assert.deepEqual(pendingTool(at, TOOLS), { name: "Bash", about: huge.slice(0, 4000) }, "whole, to 4000 characters");
  assert.equal(pendingTool(path.join(tmp, "none.jsonl"), TOOLS), undefined);
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

type Unfolded = { about: string; use: string; lines: string[]; answer: unknown };
const conformance = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../conformance/conversation.json"), "utf8")) as {
  mapped: { transcript: AgentTranscript };
  unfolded: { mapped: Unfolded[]; claude: Unfolded[] };
};
/** Claude Code's mapping, as the agents published hold it. */
const claudeMapping = async () => (await readAgentManifest(path.join(import.meta.dirname, "../../hive-agents/tests/fixtures/published-agents/claude/agent.yaml"), { source: "user", requireDirMatch: true })).def!.session!.transcript!;

test("a tool use unfolded is read as the unfolded cases say: its input and what it gave back whole, from the records that name it wherever they are in the file", async () => {
  const cases: Array<[AgentTranscript, Unfolded[]]> = [[conformance.mapped.transcript, conformance.unfolded.mapped], [await claudeMapping(), conformance.unfolded.claude]];
  for (const [mapping, unfolded] of cases) {
    assert.ok(unfolded.length > 0);
    for (const c of unfolded) assert.deepEqual(toolUse(sessionFile(`${c.lines.join("\n")}\n`), mapping, c.use) ?? null, c.answer, c.about);
  }
  assert.equal(toolUse(path.join(tmp, "no-such.jsonl"), conformance.mapped.transcript, "c1"), undefined);
});

test("unfolded, a tool's input, what it is about and what it gave back are each cut to 256 KiB, and it says so", () => {
  const big = "y".repeat(TOOL_MAX + 10);
  const line = (rid: string, kind: string, payload: unknown) => JSON.stringify({ rid, ts: "2026-10-02T08:00:00.000Z", kind, payload });
  const at = sessionFile(`${line("r1", "call", { call_id: "c1", name: "shell", args: { cmd: big } })}\n${line("r2", "output", { call_id: "c1", output: big })}\n`);
  const got = toolUse(at, conformance.mapped.transcript, "c1")!;
  assert.deepEqual([got.about?.length, got.input?.length, got.result?.text.length, got.truncated], [TOOL_MAX, TOOL_MAX, TOOL_MAX, true]);
  const small = sessionFile(`${line("r1", "call", { call_id: "c2", name: "shell", args: "ls" })}\n`);
  assert.equal(toolUse(small, conformance.mapped.transcript, "c2")!.truncated, undefined);
});

test("asked for a tool use an agent made, the caller is answered it unfolded; one its session does not name, or an agent keeping no conversation, is not found", async () => {
  const c = conformance.unfolded.mapped[0]!;
  const at = sessionFile(`${c.lines.join("\n")}\n`);
  const { server, client } = served(() => ({ session: "s1", file: at, format: conformance.mapped.transcript }));
  const phone = client();
  try {
    assert.deepEqual(await server.answer("agent.tool", ["hm:t1", c.use], phone), { result: c.answer });
    const code = async (params: unknown[]) => ((await server.answer("agent.tool", params, phone)) as { error?: { code: string } }).error?.code;
    assert.deepEqual([await code(["t1", "c9"]), await code(["t7", "c1"]), await code(["t1"])], ["NOT_FOUND", "NOT_FOUND", "BAD_REQUEST"]);
  } finally {
    phone.go();
  }
});

test("asked before the agent has said anything, its session file not yet there, the caller is answered nothing, then once its file is there sent the last of it and what is written to it; a tile where no agent keeps a conversation is not looked at again", async () => {
  let kept: Transcript = { session: "s1", file: null, format: FORMAT };
  let asked = 0;
  const server = new WorkspaceServer([conversations({ transcriptOf: (tile) => (tile === "t1" ? kept : (asked++, null)) })], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const closing = new AbortController();
  const got: EventMessage[] = [];
  const phone: Connection & { got: EventMessage[]; go(): void } = { actor: { kind: "person" }, got, send: (m) => got.push(m), closed: closing.signal, go: () => closing.abort() };
  server.connect(phone);
  try {
    assert.deepEqual(await server.answer("agent.conversation", ["t1"], phone), { result: { entries: [], cursor: 0 } });
    assert.deepEqual(await server.answer("agent.conversation", ["t7"], phone), { result: { entries: [], cursor: 0 } });
    await wait(1500);
    assert.equal(asked, 1, "t7, where no agent keeps a conversation, is not followed");
    assert.deepEqual(phone.got, []);
    const at = sessionFile(said(0));
    kept = { session: "s1", file: at, format: FORMAT };
    for (let t = 0; t < 4000 && phone.got.length === 0; t += 20) await wait(20);
    assert.deepEqual(phone.got.map((e) => [ids({ result: { entries: e.params[1] } }), e.params[3]]), [[["u0"], "s1"]]);
    fs.appendFileSync(at, said(1));
    for (let t = 0; t < 3000 && phone.got.length === 1; t += 20) await wait(20);
    assert.deepEqual(phone.got.map((e) => [ids({ result: { entries: e.params[1] } }), e.params[3]]), [[["u0"], "s1"], [["u1"], "s1"]]);
  } finally {
    phone.go();
  }
});

test("followed, an agent that begins another session (Claude Code's /clear) is followed in it: the last of it, then what is written to it, each named by it; the one before says no more", async () => {
  const before = sessionFile(said(0));
  let kept: Transcript | null = { session: "s1", file: before, format: FORMAT };
  const { server, client } = served(() => kept);
  const phone = client();
  try {
    assert.deepEqual(ids(await server.answer("agent.conversation", ["t1"], phone)), ["u0"]);
    // Begun, its file not yet written: still the one before.
    kept = { session: "s2", file: null, format: FORMAT };
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

test("an agent's session is the one last recorded for its tile, else the one bound as it started, its file where its manifest says, read as its manifest maps it, its file none while it is not there; none at all when the manifest maps no transcript or no agent is there", () => {
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
  assert.deepEqual(transcriptOf(held, "t1", sessions, home), { session: "s-gone", file: null, format: FORMAT }, "a session whose file is not there yet");
  assert.equal(TILE_SESSIONS_DIR, "tile-sessions");
});

test("what an agent last said, in a line: the first line of its last words, or the tool it last used and what about, what tools gave back passed over; at most 160 characters", () => {
  const TOOLS: AgentTranscript = {
    id: "uuid", at: "timestamp",
    said: [
      { require: { type: "assistant" }, each: "message.content", item: { type: "text" }, text: "text", who: "agent" },
      { require: { type: "assistant" }, each: "message.content", item: { type: "tool_use" }, tool: { id: "id", name: "name", about: ["input.command"] } },
      { require: { type: "user" }, each: "message.content", item: { type: "tool_result" }, result: { of: "tool_use_id", text: "content" } },
    ],
  };
  let n = 0;
  const record = (type: string, ...content: object[]) =>
    `${JSON.stringify({ type, uuid: `l${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content } })}\n`;
  const at = sessionFile(record("assistant", { type: "text", text: "\n  The build is green.  \n42 tests pass." }));
  assert.equal(lastSaid(at, TOOLS), "The build is green.");
  fs.appendFileSync(at, record("assistant", { type: "tool_use", id: "u1", name: "Bash", input: { command: "npm test" } }));
  fs.appendFileSync(at, record("user", { type: "tool_result", tool_use_id: "u1", content: "ok" }));
  assert.equal(lastSaid(at, TOOLS), "Bash · npm test");
  fs.appendFileSync(at, record("assistant", { type: "text", text: "x".repeat(200) }));
  assert.equal(lastSaid(at, TOOLS), "x".repeat(160));
  assert.equal(lastSaid(sessionFile(""), TOOLS), undefined);
  assert.equal(lastSaid(path.join(tmp, "none.jsonl"), TOOLS), undefined);
});

test("for Home, what each agent last said is read again only when its file grows or shrinks; which file it keeps is looked for each time until found, then again after 5 s", () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const sessions = path.join(tmp, `tile-sessions-${made++}`);
  const project = path.join(home, ".claude", "projects", "-home-p-api");
  fs.mkdirSync(project, { recursive: true });
  const AGENT: AgentTranscript = { id: "uuid", at: "timestamp", said: [{ require: { type: "assistant" }, text: "message.content", who: "agent" }] };
  const words = (n: number, text: string) => `${JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: new Date(1_790_000_000_000 + n).toISOString(), message: { content: text } })}\n`;
  const claude = {
    id: "claude", label: "Claude Code", bin: "claude", enabled: true,
    session: { transcript: AGENT, resume: { args: ["--resume", "{id}"], from: { bound: "--session-id" }, exists: "{home}/.claude/projects/*/{id}.jsonl" } },
  } as unknown as AgentProviderDef;
  setCatalog([claude]);
  const held = [{ workspace: "w", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [
    { id: "t1", kind: "claude", label: "Claude", cmd: "claude", args: ["--session-id", "s1"] },
    { id: "t2", kind: "terminal", label: "Terminal" },
  ] } }] as never;
  let now = 0;
  const last = new LastSaid({ tileSessionsDir: sessions, home, now: () => now });
  assert.equal(last.line(held, "t1"), undefined, "nothing written yet");
  fs.writeFileSync(path.join(project, "s1.jsonl"), words(1, "Reading the code"));
  assert.equal(last.line(held, "t1"), "Reading the code", "a file not found yet is looked for again at once");
  now = 5000;
  fs.writeFileSync(path.join(project, "s1.jsonl"), words(1, "Reading the dode"));
  assert.equal(last.line(held, "t1"), "Reading the code", "the same size: not read again");
  fs.appendFileSync(path.join(project, "s1.jsonl"), words(2, "Done"));
  assert.equal(last.line(held, "t1"), "Done");
  fs.writeFileSync(path.join(project, "s2.jsonl"), words(3, "A new session"));
  writeTrackedSession(sessions, "hm:t1", "s2");
  assert.equal(last.line(held, "t1"), "Done", "the session it began since is looked for after 5 s");
  now = 10_000;
  assert.equal(last.line(held, "t1"), "A new session");
  assert.equal(last.line(held, "t2"), undefined, "a terminal keeps no conversation");
});
