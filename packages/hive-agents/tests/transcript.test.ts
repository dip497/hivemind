// An agent's session file read as a conversation (transcript.ts, spec/agents.md "Conversation"):
// the mapping rules read records as conformance/conversation.json's `mapped` cases say, whatever
// agent keeps them; a manifest's mapping is checked as it is loaded; and Claude Code's manifest
// maps Claude Code's file as the `claude` cases say.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { defFromManifest } from "../src/manifest.js";
import { toolAbout, transcriptEntries } from "../src/transcript.js";
import type { AgentTranscript } from "../src/types.js";
import { AUTHORED, authoredYaml } from "./authored.js";

type Case = { about: string; lines: string[]; entries: unknown[] };
const conformance = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../conformance/conversation.json"), "utf8")) as {
  claude: Case[];
  mapped: { transcript: AgentTranscript; cases: Case[] };
};
const claude = () => YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "claude")!));
/** Claude Code's manifest, its session's `transcript` as given. */
const withTranscript = (transcript: unknown) => {
  const base = claude();
  return { ...base, session: { ...base.session, transcript } };
};

test("a mapping a manifest may hold reads records as the mapped cases say, whatever agent keeps them", () => {
  const taken = defFromManifest(withTranscript(conformance.mapped.transcript)).session!.transcript!;
  expect(taken).toEqual(conformance.mapped.transcript);
  expect(conformance.mapped.cases.length).toBeGreaterThan(0);
  for (const c of conformance.mapped.cases) expect(transcriptEntries(taken, c.lines), c.about).toEqual(c.entries);
});

test("Claude Code's manifest maps its session file as the claude cases say", () => {
  const mapping = defFromManifest(claude()).session!.transcript!;
  expect(conformance.claude.length).toBeGreaterThan(0);
  for (const c of conformance.claude) expect(transcriptEntries(mapping, c.lines), c.about).toEqual(c.entries);
});

test("a manifest that declares no notices reads what an agent's program wrote as before, as the person's", () => {
  const { notices: _notices, unwrap: _unwrap, ...older } = defFromManifest(claude()).session!.transcript!;
  const written = "<task-notification><summary>Agent \"Tidy\" finished</summary></task-notification>";
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-01T10:00:00.000Z", message: { content: written } });
  expect(transcriptEntries(older, [line])).toEqual([{ id: "u1", at: Date.parse("2026-10-01T10:00:00.000Z"), who: "person", text: written }]);
});

test("what a notice's line and detail hold is bounded, and a long detail is cut, not dropped", () => {
  const mapping = defFromManifest(withTranscript({
    id: "uuid", at: "timestamp",
    said: [{ require: { type: "user" }, text: "message.content", who: "person" }],
    notices: [{ require: { type: "user" }, text: "message.content", elements: ["done"], reads: "done.title", detail: ["done.log"], says: [{ say: "{done.title}" }] }],
  })).session!.transcript!;
  const line = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-10-01T10:00:00.000Z", message: { content: `<done><title>${"t\n".repeat(200)}</title><log>${"l".repeat(9000)}</log></done>` } });
  const [entry] = transcriptEntries(mapping, [line]) as Array<{ notice: { text: string; detail: string } }>;
  expect(entry!.notice.text.length).toBe(160);
  expect(entry!.notice.text).not.toContain("\n");
  expect(entry!.notice.detail.length).toBe(4000);
});

test("a manifest's notices are checked as it is loaded", () => {
  const said = [{ require: { type: "user" }, each: "list", item: { type: "text" }, text: "text", who: "person" }];
  const refused: Array<[unknown, RegExp]> = [
    [[], /notices must be 1-16/],
    [[{}], /says must be/],
    [[{ says: [{}] }], /say must be text/],
    [[{ says: [{ say: "x".repeat(201) }] }], /say must be text/],
    [[{ says: [{ when: "x", say: "y" }] }], /when needs text/],
    [[{ text: "a", says: [{ say: "y", quiet: "yes" }] }], /quiet must be true/],
    [[{ elements: ["a"], says: [{ say: "y" }] }], /elements needs text/],
    [[{ text: "a", elements: ["a b"], says: [{ say: "y" }] }], /elements must be/],
    [[{ text: "a", elements: ["a"], reads: "b", says: [{ say: "y" }] }], /reads must be an element/],
    [[{ text: "a", elements: ["a"], detail: ["a.b.c"], says: [{ say: "y" }] }], /must be an element/],
    [[{ each: "other", text: "a", says: [{ say: "y" }] }], /each must be a list/],
    [[{ text: "a", who: "agent", says: [{ say: "y" }] }], /who may only be person/],
  ];
  for (const [notices, why] of refused) {
    expect(() => defFromManifest(withTranscript({ id: "uuid", at: "timestamp", said, notices })), JSON.stringify(notices)).toThrow(why);
  }
  expect(() => defFromManifest(withTranscript({ id: "uuid", at: "timestamp", said, unwrap: ["a b"] }))).toThrow(/unwrap must be/);
});

test("a tool use its hook gives, before its session file records it, is about what the file will say of it, whole", () => {
  const mapping = defFromManifest(claude()).session!.transcript!;
  const input = { command: "npm test \\\n  --watch", description: "Run the tests" };
  const line = JSON.stringify({ type: "assistant", uuid: "u1", timestamp: "2026-10-13T00:00:00Z", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input }] } });
  expect(toolAbout(mapping, "Bash", input)).toBe("npm test \\\n  --watch");
  expect(transcriptEntries(mapping, [line], { whole: true })).toMatchObject([{ tool: { about: toolAbout(mapping, "Bash", input) } }]);
  expect(toolAbout(mapping, "Edit", { file_path: "/p/a.ts", old_string: "a" })).toBe("/p/a.ts");
  expect(toolAbout(mapping, "Agent", { prompt: "look around" })).toBeUndefined();
});

test("a mapping's field paths read and write a record's own fields, never what every object shares", () => {
  const rule = (input: string) => ({ tool: { id: "id", name: "name", input, about: ["input.command"] } });
  for (const input of ["__proto__.polluted", "constructor.prototype.polluted"]) {
    const taken = defFromManifest(withTranscript({ id: "uuid", at: "timestamp", said: [rule(input)] })).session!.transcript!;
    expect(toolAbout(taken, "Bash", { command: "ls" }), input).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted, input).toBeUndefined();
  }
  const taken = defFromManifest(withTranscript({ id: "uuid", at: "timestamp", said: [rule("input")] })).session!.transcript!;
  expect(toolAbout(taken, "Bash", { command: "ls" })).toBe("ls");
});

test("a mapping is refused as it is loaded unless every rule reads one thing it can name, and the session file is named", () => {
  const rule = { require: { type: "user" }, text: "message.content", who: "person" };
  const mapping = (said: unknown[], more: Record<string, unknown> = {}) => ({ id: "uuid", at: "timestamp", said, ...more });
  const refused: Array<[unknown, RegExp]> = [
    ["claude", /session.transcript must be a map/],
    [mapping([]), /session.transcript.said must be 1-16 rules/],
    [{ at: "timestamp", said: [rule] }, /session.transcript.id must be a field path/],
    [mapping([rule], { skipWhen: { "not a path": true } }), /session.transcript.skipWhen must map 1-4 field paths/],
    [mapping([{ ...rule, tool: { id: "id", name: "name" } }]), /said\[0\] must read exactly one of text, tool or result/],
    [mapping([{ require: { type: "user" }, text: "message.content" }]), /said\[0\].who must be person or agent/],
    [mapping([{ tool: { id: "id", name: "name" }, who: "agent" }]), /said\[0\].who goes with text alone/],
    [mapping([{ item: { type: "text" }, text: "text", who: "agent" }]), /said\[0\].item needs each/],
    [mapping([{ require: { type: { nested: 1 } }, text: "text", who: "agent" }]), /said\[0\].require must map 1-4 field paths/],
    [mapping([{ result: { of: "tool_use_id" } }]), /said\[0\].result.text must be a field path/],
    [mapping([{ tool: { id: "id", name: "name", about: [] } }]), /said\[0\].tool.about must be 1-8 field paths/],
    [mapping([{ tool: { id: "id", name: "name", input: "not a path" } }]), /said\[0\].tool.input must be a field path/],
  ];
  for (const [transcript, why] of refused) expect(() => defFromManifest(withTranscript(transcript)), String(why)).toThrow(why);
  const { exists: _, ...resume } = claude().session.resume;
  expect(() => defFromManifest({ ...claude(), session: { ...claude().session, resume } })).toThrow(/session.transcript needs session.resume.exists/);
  expect(defFromManifest(withTranscript(undefined)).session!.transcript).toBeUndefined();
});
