// An agent's past sessions, from whichever source its manifest names: its own listing command,
// the headers of its session files, or the path each session is kept at.
import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canListSessions, listSessions, parseListing, sessionListed } from "../src/session.ts";
import { withResume } from "../src/catalog.ts";
import { defFromManifest } from "../src/manifest.ts";
import type { AgentProviderDef } from "../src/types.ts";

const base = { manifestVersion: 2, label: "X", caps: { promptDelivery: "typed", turnSignal: false, resume: "none", supervise: "human", blockedDetection: false } };
const def = (id: string, bin: string, session: unknown): AgentProviderDef => defFromManifest({ ...base, id, bin, session }) as AgentProviderDef;

test("a listing's records become sessions; ids that could not go on a command line are dropped", () => {
  const list = { args: ["ls"], idPath: "id", cwdPath: "directory", titlePath: "title", updatedPath: "updated" };
  const rows = parseListing(list, JSON.stringify([
    { id: "ses_1", directory: "/r", title: "Fix it", updated: 5 },
    { id: "20260926_015728_9273b6", updated: "2026-09-26T01:57:28Z" },
    { id: "--help" }, { id: "a b" }, { nope: 1 },
  ]));
  expect(rows).toEqual([
    { id: "ses_1", cwd: "/r", title: "Fix it", updated: 5 },
    { id: "20260926_015728_9273b6", updated: Date.parse("2026-09-26T01:57:28Z") },
  ]);
  expect(parseListing(list, "not json")).toEqual([]);
});

test("the agent's own listing command: newest first, scoped to a folder, and the resume check asks it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "list-bin-"));
  const bin = join(dir, "fake-agent");
  process.env.PATH = `${dir}:${process.env.PATH}`; // run by name, as the host runs an agent
  writeFileSync(bin, `#!/bin/sh\necho '[{"id":"old","directory":"/r","updated":1},{"id":"new","directory":"/r","updated":9},{"id":"elsewhere","directory":"/x","updated":5}]'\n`);
  chmodSync(bin, 0o755);
  const d = def("lister", "fake-agent", { list: { args: ["session", "list"], idPath: "id", cwdPath: "directory", updatedPath: "updated" }, resume: { args: ["--session", "{id}"] } });
  expect(canListSessions(d)).toBe(true);
  expect((await listSessions(d, { cwd: "/r" })).map((s) => s.id)).toEqual(["new", "old"]);
  expect((await listSessions(d)).map((s) => s.id)).toEqual(["new", "elsewhere", "old"]);
  expect(sessionListed(d, "old")).toBe(true);
  expect(sessionListed(d, "gone")).toBe(false);
  // A listing that prints nothing has no sessions; one that cannot run says nothing, so the id counts as there.
  writeFileSync(join(dir, "empty-agent"), "#!/bin/sh\n");
  chmodSync(join(dir, "empty-agent"), 0o755);
  expect(sessionListed(def("empty", "empty-agent", { list: { args: ["x"], idPath: "id" } }), "gone")).toBe(false);
  expect(sessionListed(def("broken", "no-such-agent-bin", { list: { args: ["x"], idPath: "id" } }), "gone")).toBe(true);
});

test("session files with a header name their id and folder", async () => {
  const home = mkdtempSync(join(tmpdir(), "list-home-"));
  const root = join(home, ".agent", "sessions", "2026");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "a.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "s-a", cwd: "/r" } }) + "\n{}\n");
  writeFileSync(join(root, "b.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "s-b", cwd: "/x" } }) + "\n");
  writeFileSync(join(root, "c.jsonl"), JSON.stringify({ type: "other" }) + "\n");
  utimesSync(join(root, "a.jsonl"), 100, 100);
  const d = def("filer", "filer", { resume: { args: ["resume", "{id}"], find: { strategy: "jsonl-header", root: "{home}/.agent/sessions", cwdPath: "payload.cwd", idPath: "payload.id", require: { type: "session_meta" } } } });
  expect(await listSessions(d, { home, cwd: "/r" })).toEqual([{ id: "s-a", cwd: "/r", updated: 100_000 }]);
  expect((await listSessions(d, { home })).map((s) => s.id)).toEqual(["s-b", "s-a"]);
});

test("the path a session is kept at: its file name is the id, its folder is not known", async () => {
  const home = mkdtempSync(join(tmpdir(), "list-glob-"));
  for (const [proj, id] of [["-r", "11111111-aaaa"], ["-x", "22222222-bbbb"]] as const) {
    mkdirSync(join(home, ".claude", "projects", proj), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", proj, `${id}.jsonl`), "{}\n");
  }
  writeFileSync(join(home, ".claude", "projects", "-r", "notes.txt"), "");
  const d = def("globber", "globber", { resume: { args: ["--resume", "{id}"], exists: "{home}/.claude/projects/*/{id}.jsonl" } });
  expect((await listSessions(d, { home })).map((s) => s.id).sort()).toEqual(["11111111-aaaa", "22222222-bbbb"]);
  expect(await listSessions(d, { home, cwd: "/r" })).toEqual([]);
});

test("an agent that says nothing about its sessions cannot list them; a resume goes where the manifest puts it", () => {
  expect(canListSessions(def("mute", "mute", undefined))).toBe(false);
  const before = def("b", "b", { resume: { args: ["--resume", "{id}"], position: "before" } });
  const after = def("a", "a", { resume: { args: ["resume", "{id}"] } });
  expect(withResume(before, ["--model", "m"], "s1")).toEqual(["--resume", "s1", "--model", "m"]);
  expect(withResume(after, ["--model", "m"], "s1")).toEqual(["--model", "m", "resume", "s1"]);
});

test("a session file's first lines give its folder and title: the first record that has each", async () => {
  const home = mkdtempSync(join(tmpdir(), "list-lines-"));
  const dir = join(home, ".claude", "projects", "-r");
  mkdirSync(dir, { recursive: true });
  const lines = (...rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(dir, "s-titled.jsonl"), lines({ type: "mode" }, { type: "user", cwd: "/r", message: { content: "fix the tests\nplease" } }, { type: "ai-title", aiTitle: "Fix flaky tests" }));
  writeFileSync(join(dir, "s-prompt.jsonl"), lines({ type: "user", cwd: "/r", message: { content: [{ type: "text" }] } }, { type: "user", message: { content: "  add a flag  " } }));
  const d = def("liner", "liner", {
    list: { lines: 30, cwdPath: "cwd", titlePath: ["aiTitle", "message.content"] },
    resume: { args: ["--resume", "{id}"], exists: "{home}/.claude/projects/*/{id}.jsonl" },
  });
  const got = Object.fromEntries((await listSessions(d, { home, cwd: "/r" })).map((s) => [s.id, s.title]));
  expect(got).toEqual({ "s-titled": "Fix flaky tests", "s-prompt": "add a flag" });
});
