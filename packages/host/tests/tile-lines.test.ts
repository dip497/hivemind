// Each tile's last line (tile-lines.ts), at the workspace API: a client that watches tiles
// (`tile.watchLines`) is answered their lines now, then told only the lines of those tiles that
// change (`tile.lines`), to it alone, at most every 250 ms; a line shown again tells nobody, nothing
// more is sent for a client that went, and one that stopped watching a tile is told nothing more of
// it. Whoever sent a line, it is kept and told as one line of plain text of at most 160 characters.
// A tile whose agent keeps a conversation shows what it last said there, read from its session
// file only while someone follows the tile, as its agent reports, and once for a one-shot read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Intents } from "@hivemind/workspace-host/intents";
import { AuditLog } from "@hivemind/workspace-host/audit-log";
import { WorkspaceServer, type Connection } from "@hivemind/workspace-api/server";
import type { EventMessage } from "@hivemind/workspace-api/protocol";
import type { AgentTranscript } from "@hivemind/agents/node";
import type { Transcript } from "../src/conversations.ts";
import { LINES_EVERY_MS, TileLines } from "../src/tile-lines.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-tile-lines-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function host(transcripts: Record<string, Transcript> = {}) {
  /** Each message TileLines sent, to anyone. */
  let sent = 0;
  const lines = new TileLines({
    server: () => ({ publishTo: (to, event, ...params) => { sent++; server.publishTo(to, event, ...params); } }),
    transcriptOf: (bare) => transcripts[bare] ?? null,
  });
  const server = new WorkspaceServer([lines.domain], new Intents(new AuditLog({ file: path.join(tmp, "audit.jsonl") })));
  const client = () => {
    const closing = new AbortController();
    const told: EventMessage[] = [];
    const c: Connection & { told: EventMessage[]; close(): void } = { actor: { kind: "person" }, told, send: (m) => told.push(m), closed: closing.signal, close: () => closing.abort() };
    server.connect(c);
    return c;
  };
  const watch = async (c: Connection, tiles: string[]) => {
    const answer = await server.answer("tile.watchLines", [tiles], c);
    if ("error" in answer) throw new Error(answer.error.message);
    return (answer.result as { lines: Record<string, string> }).lines;
  };
  /** Each `tile.lines` `c` was told, oldest first. */
  const heard = (c: { told: EventMessage[] }) => c.told.filter((m) => m.event === "tile.lines").map((m) => (m.params[0] as { lines: Record<string, string> }).lines);
  const read = async (c: Connection, tiles: string[]) => {
    const answer = await server.answer("tile.readLines", [tiles], c);
    if ("error" in answer) throw new Error(answer.error.message);
    return (answer.result as { lines: Record<string, string> }).lines;
  };
  return { lines, client, watch, read, heard, sent: () => sent };
}

/** A session file whose records are each a thing the agent said. */
const FORMAT: AgentTranscript = { id: "uuid", at: "timestamp", said: [{ require: { type: "assistant" }, text: "message.content", who: "agent" }] };
let n = 0;
const words = (text: string) => `${JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: new Date(1_790_000_000_000 + n++).toISOString(), message: { content: text } })}\n`;
/** A session `session` whose file is not written yet. */
const sessionAt = (session: string): Transcript => ({ session, file: path.join(tmp, `${session}.jsonl`), format: FORMAT });
/** Until `ok` holds, or a second passed. */
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

test("a tile's line reaches only the clients that watch it, with the tiles that changed alone, and a line it showed already tells nobody", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const [a, b] = [h.client(), h.client()];
  await h.watch(a, ["t1"]);
  await h.watch(b, ["t2"]);
  h.lines.set("t1", "npm test");
  t.mock.timers.tick(LINES_EVERY_MS);
  h.lines.set("t2", "cargo build");
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.deepEqual(h.heard(a), [{ t1: "npm test" }]);
  assert.deepEqual(h.heard(b), [{ t2: "cargo build" }]);

  h.lines.set("t1", "npm test");
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.deepEqual(h.heard(a), [{ t1: "npm test" }]);
});

test("once a client goes, nothing more is sent for what it watched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const a = h.client();
  await h.watch(a, ["t1"]);
  h.lines.set("t1", "npm test");
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.equal(h.sent(), 1);

  a.close();
  h.lines.set("t1", "214 tests passed");
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.equal(h.sent(), 1);
});

test("a line is kept and told as one line of plain text of at most 160 characters, whoever sent it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const a = h.client();
  await h.watch(a, ["t1"]);
  // What a tile's own process may send over the control-plane socket: an override, a line break, and
  // a line far past what any screen shows.
  h.lines.set("t1", `\u202enpm test\r\n${"x".repeat(10_000)}`);
  t.mock.timers.tick(LINES_EVERY_MS);
  const line = `npm test ${"x".repeat(151)}`;
  assert.deepEqual(h.heard(a), [{ t1: line }]);
  assert.equal(h.lines.get("t1"), line);
});

test("a client that watches a tile is answered its line now, by its bare id, and told only what changes after; watching others in its place stops it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  h.lines.set("t1", "building");
  const a = h.client();
  assert.deepEqual(await h.watch(a, ["hm:t1", "t2"]), { t1: "building" });
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.deepEqual(h.heard(a), []);

  assert.deepEqual(await h.watch(a, ["t2"]), {});
  h.lines.set("t1", "built");
  t.mock.timers.tick(LINES_EVERY_MS);
  assert.deepEqual(h.heard(a), []);
});

test("a client is told at once after a quiet spell, then at most every 250 ms, what changed meanwhile in one message with each line as it is now", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = host();
  const a = h.client();
  await h.watch(a, ["t1", "t2"]);
  h.lines.set("t1", "compiling");
  t.mock.timers.tick(0);
  assert.deepEqual(h.heard(a), [{ t1: "compiling" }]);

  h.lines.set("t1", "linking");
  h.lines.set("t2", "waiting");
  h.lines.set("t1", "done");
  t.mock.timers.tick(LINES_EVERY_MS - 1);
  assert.equal(h.heard(a).length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(h.heard(a), [{ t1: "compiling" }, { t1: "done", t2: "waiting" }]);
});

test("an agent that keeps a conversation shows what it last said there, \"\" until it says something; its screen never stands in; read when watched and again as it reports, the session it reports from looked for", async () => {
  const s1 = sessionAt("s1");
  const transcripts: Record<string, Transcript> = { t1: s1 };
  const h = host(transcripts);
  h.lines.set("t1", "? for shortcuts");
  const a = h.client();
  assert.deepEqual(await h.watch(a, ["t1"]), { t1: "" }, "nothing said yet, and its screen's chrome does not stand in");

  fs.writeFileSync(s1.file!, words("Reading the code"));
  h.lines.reported("t1");
  await until(() => h.heard(a).length > 0);
  assert.deepEqual(h.heard(a), [{ t1: "Reading the code" }]);

  fs.appendFileSync(s1.file!, words("Done: 214 tests pass"));
  h.lines.reported("t1", "s1");
  await until(() => h.heard(a).length > 1);
  assert.deepEqual(h.heard(a).at(-1), { t1: "Done: 214 tests pass" });

  const s2 = sessionAt("s2");
  fs.writeFileSync(s2.file!, words("A new session"));
  transcripts.t1 = s2;
  h.lines.reported("t1", "s2");
  await until(() => h.heard(a).length > 2);
  assert.deepEqual(h.heard(a).at(-1), { t1: "A new session" }, "the session it reports from is looked for, and read from its end");
});

test("what an agent said is read only while someone follows its tile; a one-shot read reads it first, and Home following reads every tile it asks for", async () => {
  const s3 = sessionAt("s3");
  fs.writeFileSync(s3.file!, words("Planning the change"));
  const s4 = sessionAt("s4");
  fs.writeFileSync(s4.file!, words("Asleep since noon"));
  const h = host({ t1: s3, t2: s4 });
  const a = h.client();
  h.lines.reported("t1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.lines.get("t1"), "", "followed by no one: not read");

  assert.deepEqual(await h.read(a, ["t1", "t9"]), { t1: "Planning the change" }, "a one-shot read waits for it");

  fs.appendFileSync(s3.file!, words("Writing the tests"));
  h.lines.reported("t1");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.lines.get("t1"), "Planning the change", "a one-shot read follows nothing");

  h.lines.followAll(true);
  h.lines.reported("t1");
  await until(() => h.lines.get("t1") === "Writing the tests");
  assert.equal(h.lines.get("t1"), "Writing the tests", "Home follows every tile");
  assert.equal(h.lines.get("t2"), "", "a tile Home asks for whose agent's words were never read");
  await until(() => h.lines.get("t2") !== "");
  assert.equal(h.lines.get("t2"), "Asleep since noon", "is read, with no report of its agent's");
});
