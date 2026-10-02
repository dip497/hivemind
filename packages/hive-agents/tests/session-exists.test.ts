// A resume the manifest can check before handing it to the agent.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { sessionExists, sessionFile } from "../src/session.js";
import { defFromManifest } from "../src/manifest.js";
import { AUTHORED, authoredYaml } from "./authored.js";

const PATTERN = "{home}/.claude/projects/*/{id}.jsonl";

test("a session is found under any one directory, and only there", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sx-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "-repo"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-repo", "abc-1.jsonl"), "{}");
  expect(sessionExists(PATTERN, "abc-1", home)).toBe(true);
  expect(sessionExists(PATTERN, "abc-2", home)).toBe(false);
  expect(sessionExists("{home}/.claude/projects/-repo/{id}.jsonl", "abc-1", home)).toBe(true);
  // An id that could leave the store is never looked up.
  expect(sessionExists(PATTERN, "../../etc/passwd", home)).toBe(false);
  // No store at all: nothing to resume.
  expect(sessionExists(PATTERN, "abc-1", path.join(home, "nope"))).toBe(false);
  fs.rmSync(home, { recursive: true, force: true });
});

test("the manifest may only name a store inside home, with {id} and at most one whole-segment *", () => {
  const base = YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "claude")!));
  const withExists = (exists: string) => ({ ...base, session: { ...base.session, resume: { ...base.session.resume, exists } } });
  expect(defFromManifest(withExists(PATTERN)).session!.resume!.exists).toBe(PATTERN);
  for (const bad of ["/etc/{id}", "{home}/../{id}.jsonl", "{home}/.claude/projects/x.jsonl", "{home}/*/*/{id}", "{home}/p*/{id}"]) {
    expect(() => defFromManifest(withExists(bad)), bad).toThrow(/session.resume.exists/);
  }
});

test("a session's file is found where its store says, under any one directory; none when it is not there, or the id could leave the store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sf-"));
  const at = path.join(home, ".claude", "projects", "-repo", "abc-1.jsonl");
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, "{}");
  expect(sessionFile(PATTERN, "abc-1", home)).toBe(at);
  expect(sessionFile("{home}/.claude/projects/-repo/{id}.jsonl", "abc-1", home)).toBe(at);
  expect(sessionFile(PATTERN, "abc-2", home)).toBeNull();
  expect(sessionFile(PATTERN, "../../etc/passwd", home)).toBeNull();
  expect(sessionFile(PATTERN, "abc-1", path.join(home, "nope"))).toBeNull();
  fs.rmSync(home, { recursive: true, force: true });
});

test("the manifest may name its session file's format, Claude Code's alone, and only with where the file is", () => {
  const base = YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "claude")!));
  expect(defFromManifest(base).session!.transcript).toBe("claude");
  const without = { ...base, session: { ...base.session, transcript: undefined } };
  expect(defFromManifest(without).session!.transcript).toBeUndefined();
  expect(() => defFromManifest({ ...base, session: { ...base.session, transcript: "codex" } })).toThrow(/session.transcript must be "claude"/);
  const { exists: _, ...resume } = base.session.resume;
  expect(() => defFromManifest({ ...base, session: { ...base.session, resume } })).toThrow(/session.transcript needs session.resume.exists/);
});
