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
import { followConversation, lastSaidSince, pendingTool, readConversation, TAIL_BYTES, TAIL_ENTRIES, TOOL_MAX, toolUse } from "../src/conversation.ts";
import { askingOf, conversationOf, conversations, transcriptOf, type Transcript } from "../src/conversations.ts";
import { manifestFacts } from "../src/agent-list.ts";

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
function served(kept: () => Transcript | null, runsHere = (tile: string) => tile === "t1") {
  const server = new WorkspaceServer([conversations({ transcriptOf: (tile) => (tile === "t1" || tile === "t2" ? kept() : null), runsHere })], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
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

test("in a long session, read back from its end a piece at a time, each tool use unfolds whole, what it gave back cut across pieces or not", () => {
  const line = (rid: string, kind: string, payload: unknown) => JSON.stringify({ rid, ts: "2026-10-02T08:00:00.000Z", kind, payload });
  const lines = Array.from({ length: 24 }, (_, i) => [
    line(`r${i}a`, "call", { call_id: `c${i}`, name: "shell", args: { cmd: `step ${i}` } }),
    line(`r${i}b`, "output", { call_id: `c${i}`, output: `${i}`.repeat(TOOL_MAX - 1 + i) + "y".repeat(400_000 + 7919 * i) }),
  ]).flat();
  // One used first and answered last, all the others between.
  const far = [line("rfa", "call", { call_id: "cfar", name: "shell", args: { cmd: "wait" } }), line("rfb", "output", { call_id: "cfar", output: "done" })];
  const long = sessionFile(`${[far[0], ...lines, far[1]].join("\n")}\n`);
  assert.ok(fs.statSync(long).size > 10 * 1024 * 1024);
  for (let i = 0; i < 24; i++) {
    const alone = sessionFile(`${lines[2 * i]}\n${lines[2 * i + 1]}\n`);
    assert.deepEqual(toolUse(long, conformance.mapped.transcript, `c${i}`), toolUse(alone, conformance.mapped.transcript, `c${i}`), `c${i}`);
  }
  const farAlone = toolUse(sessionFile(`${far.join("\n")}\n`), conformance.mapped.transcript, "cfar");
  assert.equal(farAlone?.result?.text, "done");
  assert.deepEqual(toolUse(long, conformance.mapped.transcript, "cfar"), farAlone);
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
    // Written by an agent with no hooks, whose status says nothing of it.
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

test("followed, an agent that begins another session (Claude Code's /clear), its status saying nothing of it, is followed in it, its file looked for until it is written: the last of it, then what is written to it, each named by it; the one before says no more", async () => {
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

test("an agent's session is the one last recorded for its tile, else the one bound as it started, its file where its manifest says, read as its manifest maps it, its file none while it is not there; none at all when the manifest maps no transcript, says not where its file is, or no agent is there; and the agents listed keep a conversation exactly when they have one", () => {
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
  const unfound = { ...claude, id: "unfound", bin: "unfound", session: { transcript: FORMAT, resume: { args: ["--resume", "{id}"] } } } as unknown as AgentProviderDef;
  setCatalog([claude, plain, unfound]);
  const held = [{ workspace: "w", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [
    { id: "t1", kind: "claude", label: "Claude", cmd: "claude", args: ["--session-id", "s-bound"] },
    { id: "t2", kind: "plain", label: "Plain", cmd: "plain", args: ["--session-id", "s-bound"] },
    { id: "t3", kind: "unfound", label: "Unfound", cmd: "unfound", args: ["--session-id", "s-bound"] },
  ] } }] as never;
  assert.deepEqual(transcriptOf(held, "hm:t1", sessions, home), { session: "s-bound", file: path.join(project, "s-bound.jsonl"), format: FORMAT });
  writeTrackedSession(sessions, "hm:t1", "s-tracked");
  assert.deepEqual(transcriptOf(held, "t1", sessions, home), { session: "s-tracked", file: path.join(project, "s-tracked.jsonl"), format: FORMAT });
  assert.equal(transcriptOf(held, "t2", sessions, home), null);
  assert.equal(transcriptOf(held, "t3", sessions, home), null);
  assert.equal(transcriptOf(held, "t9", sessions, home), null);
  // What the phone is told decides between its chat and its terminal.
  const facts = manifestFacts(held);
  assert.deepEqual(["t1", "t2", "t3", "t9"].map((t) => facts.converses(t)), [true, false, false, false]);
  writeTrackedSession(sessions, "hm:t1", "s-gone");
  assert.deepEqual(transcriptOf(held, "t1", sessions, home), { session: "s-gone", file: null, format: FORMAT }, "a session whose file is not there yet");
  assert.equal(TILE_SESSIONS_DIR, "tile-sessions");
});

test("the tool use an agent waits on is read from its session file as it is now: after the agent writes to it, and from the next session's once it begins one", () => {
  const home = fs.mkdtempSync(path.join(tmp, "home-"));
  const sessions = path.join(tmp, `tile-sessions-${made++}`);
  const project = path.join(home, ".claude", "projects", "-home-p-api");
  fs.mkdirSync(project, { recursive: true });
  const TOOLS: AgentTranscript = {
    id: "uuid", at: "timestamp",
    said: [
      { require: { type: "assistant" }, each: "message.content", item: { type: "tool_use" }, tool: { id: "id", name: "name", about: ["input.command"] } },
      { require: { type: "user" }, each: "message.content", item: { type: "tool_result" }, result: { of: "tool_use_id", text: "content" } },
    ],
  };
  let n = 0;
  const record = (type: string, ...content: object[]) =>
    `${JSON.stringify({ type, uuid: `r${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content } })}\n`;
  const claude = { id: "claude", label: "Claude Code", bin: "claude", enabled: true, session: { transcript: TOOLS, resume: { args: ["--resume", "{id}"], exists: "{home}/.claude/projects/*/{id}.jsonl" } } } as unknown as AgentProviderDef;
  setCatalog([claude]);
  const held = [{ workspace: "w", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [{ id: "t1", kind: "claude", label: "Claude", cmd: "claude", args: [] }] } }] as never;
  const first = path.join(project, "s-a.jsonl");
  fs.writeFileSync(first, record("assistant", { type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } }));
  writeTrackedSession(sessions, "hm:t1", "s-a");
  assert.deepEqual(askingOf(held, "t1", sessions, home), { name: "Bash", about: "ls" });
  fs.appendFileSync(first, record("user", { type: "tool_result", tool_use_id: "u1", content: "" }) + record("assistant", { type: "tool_use", id: "u2", name: "Bash", input: { command: "make" } }));
  const then = new Date(1_790_000_000_000);
  fs.utimesSync(first, then, then);
  assert.deepEqual(askingOf(held, "t1", sessions, home), { name: "Bash", about: "make" });
  // The next session's file the same size and time as the one before: only which file it is differs.
  const next = path.join(project, "s-b.jsonl");
  fs.writeFileSync(next, fs.readFileSync(first, "utf8").replace('"make"', '"mak2"'));
  fs.utimesSync(next, then, then);
  writeTrackedSession(sessions, "hm:t1", "s-b");
  assert.deepEqual(askingOf(held, "hm:t1", sessions, home), { name: "Bash", about: "mak2" });
});

test("the conversation a tile is in is the one recorded for it, else the one its command line names, for any agent that resumes one, never the newest in its folder; an agent that resumes none is in none", () => {
  const sessions = path.join(tmp, `tile-sessions-${made++}`);
  // Its store keeps a conversation for the folder its tile runs in.
  const store = fs.mkdtempSync(path.join(tmp, "store-"));
  fs.writeFileSync(path.join(store, "c.jsonl"), `${JSON.stringify({ id: "0b6c1a52-7d0e-4c55-9f43-2a8f6f2b9c11", cwd: "/home/p/api" })}\n`);
  const folio = {
    id: "folio", label: "Folio", bin: "folio", enabled: true,
    session: { resume: { args: ["--resume", "{id}"], find: { strategy: "jsonl-header", root: store, cwdPath: "cwd", idPath: "id" } } },
  } as unknown as AgentProviderDef;
  const plain = { id: "plain", label: "Plain", bin: "plain", enabled: true } as unknown as AgentProviderDef;
  setCatalog([folio, plain]);
  const held = [{ workspace: "w", name: "api", repo: "/home/p/api", core: { frames: [], tiles: [
    { id: "t1", kind: "folio", label: "Folio", cmd: "folio" },
    { id: "t2", kind: "folio", label: "Folio", cmd: "folio", args: ["--resume", "s-named"] },
    { id: "t3", kind: "plain", label: "Plain", cmd: "plain", args: ["--resume", "s-named"] },
  ] } }] as never;
  assert.equal(conversationOf(held, "t1", sessions), undefined);
  assert.equal(conversationOf(held, "t2", sessions), "s-named");
  writeTrackedSession(sessions, "hm:t1", "s-recorded");
  writeTrackedSession(sessions, "hm:t2", "s-recorded-2");
  writeTrackedSession(sessions, "hm:t3", "s-recorded-3");
  assert.deepEqual(["t1", "hm:t2", "t3", "t9"].map((t) => conversationOf(held, t, sessions)), ["s-recorded", "s-recorded-2", undefined, undefined]);
});

test("what an agent last said, in a line: the first line of its last words, or the tool it last used and what about, what tools gave back passed over; at most 160 characters; from a cursor, only what was written since", async () => {
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
  const first = await lastSaidSince(at, TOOLS);
  assert.deepEqual(first, { line: "The build is green.", cursor: fs.statSync(at).size });
  fs.appendFileSync(at, record("assistant", { type: "tool_use", id: "u1", name: "Bash", input: { command: "npm test" } }));
  fs.appendFileSync(at, record("user", { type: "tool_result", tool_use_id: "u1", content: "ok" }));
  const next = await lastSaidSince(at, TOOLS, first.cursor);
  assert.deepEqual(next, { line: "Bash · npm test", cursor: fs.statSync(at).size });
  fs.appendFileSync(at, record("user", { type: "tool_result", tool_use_id: "u0", content: "ok" }));
  assert.equal((await lastSaidSince(at, TOOLS, next.cursor)).line, undefined, "what was written since says nothing: what was said before stands");
  fs.appendFileSync(at, record("assistant", { type: "text", text: "x".repeat(200) }));
  assert.equal((await lastSaidSince(at, TOOLS)).line, "x".repeat(160));
  // What the agent writes for itself as it resumes, many times over, says nothing.
  for (let i = 0; i < 200; i++) fs.appendFileSync(at, `${JSON.stringify({ type: "cost-state", uuid: `c${i}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), cost: "0".repeat(600) })}\n`);
  assert.ok(fs.statSync(at).size > 128 * 1024);
  assert.equal((await lastSaidSince(at, TOOLS)).line, "x".repeat(160));
  assert.equal((await lastSaidSince(at, TOOLS, fs.statSync(at).size + 1)).line, "x".repeat(160), "a cursor past its end: written again, read from its end");
  assert.equal((await lastSaidSince(sessionFile(""), TOOLS)).line, undefined);
  assert.deepEqual(await lastSaidSince(path.join(tmp, "none.jsonl"), TOOLS), { line: undefined, cursor: undefined });
});

test("from a cursor more than 1 MiB behind, what an agent last said is read from the end of its file, never the whole gap: its last words, and none from megabytes back", async () => {
  const AGENT: AgentTranscript = { id: "uuid", at: "timestamp", said: [{ require: { type: "assistant" }, text: "message.content", who: "agent" }] };
  let n = 0;
  const words = (text: string) => `${JSON.stringify({ type: "assistant", uuid: `g${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content: text } })}\n`;
  const noise = () => `${JSON.stringify({ type: "cost-state", uuid: `g${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), cost: "0".repeat(1000) })}\n`;
  const at = sessionFile(words("Started"));
  const { cursor } = await lastSaidSince(at, AGENT);
  // Words just past the cursor, then 5 MiB the agent wrote for itself: past the cap and the widest read.
  fs.appendFileSync(at, words("Megabytes back") + noise().repeat(5 * 1024));
  const size = fs.statSync(at).size;
  assert.deepEqual(await lastSaidSince(at, AGENT, cursor), { line: undefined, cursor: size }, "nothing in its last 4 MiB says anything: what was said before stands");
  fs.appendFileSync(at, noise().repeat(1200) + words("Latest words"));
  assert.deepEqual(await lastSaidSince(at, AGENT, cursor), { line: "Latest words", cursor: fs.statSync(at).size });
});

test("a tool use is looked for only in what the caller was shown of the conversation, from a whole line, never the whole session file", async () => {
  const line = (rid: string, kind: string, payload: unknown) => JSON.stringify({ rid, ts: "2026-10-02T08:00:00.000Z", kind, payload });
  const use = (id: string) => [line(`${id}a`, "call", { call_id: id, name: "shell", args: { cmd: id } }), line(`${id}b`, "output", { call_id: id, output: "ok" })];
  const filler = Array.from({ length: 1200 }, (_, i) => line(`f${i}`, "note", { text: "x".repeat(1000) }));
  const long = sessionFile(`${[...use("old"), ...filler, ...use("new")].join("\n")}\n`);
  const head = `${use("a").join("\n")}\n`;
  const short = sessionFile(`${head}${use("b").join("\n")}\n`);
  let file = long;
  const { server, client } = served(() => ({ session: "s1", file, format: conformance.mapped.transcript }));
  const phone = client();
  const found = async (id: string) => "result" in (await server.answer("agent.tool", ["t1", id], phone));
  try {
    assert.deepEqual([await found("new"), await found("old")], [true, false]);
    await server.answer("agent.conversation", ["t1"], phone);
    assert.deepEqual([await found("new"), await found("old")], [true, false]);
    file = short;
    await server.answer("agent.conversation", ["t1", Buffer.byteLength(head), "s1"], phone);
    assert.deepEqual([await found("b"), await found("a")], [true, false]);
  } finally {
    phone.go();
  }
});

test("a program on this machine is told the session file of an agent here; a phone, a guest and an agent on another machine are not", async () => {
  const at = sessionFile(said(0));
  // t1 runs here; t2 on another machine, its file there.
  const { server } = served(() => ({ session: "s1", file: at, format: FORMAT }));
  const as = (actor: Connection["actor"]): Connection => ({ actor, send: () => {}, closed: new AbortController().signal });
  const program = as({ kind: "peer", person: "client:g1", device: "client:g1", access: "view", client: "orchestrator" });
  const phone = as({ kind: "peer", person: "p".repeat(64), device: "d".repeat(64), access: "owner" });
  const codeOf = (a: unknown) => (a as { error?: { code: string } }).error?.code;
  assert.deepEqual(await server.answer("agent.transcript", ["hm:t1"], program), { result: { session: "s1", path: at } });
  assert.deepEqual(await server.answer("agent.transcript", ["t1"], as({ kind: "person" })), { result: { session: "s1", path: at } });
  assert.equal(codeOf(await server.answer("agent.transcript", ["t1"], phone)), "UNSUPPORTED");
  assert.equal(codeOf(await server.answer("agent.transcript", ["t2"], program)), "UNSUPPORTED");
  assert.equal(codeOf(await server.answer("agent.transcript", ["t9"], program)), "NOT_FOUND");
});
