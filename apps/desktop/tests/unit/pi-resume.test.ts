// pi-resume — resolve the newest session id for a cwd + restore transforms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pi has no code of its own: its manifest says where its sessions are, which file it
// needs written, and what that adds to the command line.
const { findSession, manifestRuntime, transformsFor, specIsAgent } = await import("@hivemind/agents/node");
const { bundledAgent } = await import("@hivemind/agents");
const piDef = bundledAgent("pi");
const isPi = (spec: { cmd: string }) => specIsAgent(piDef, spec);
const newestPiSessionForCwd = (cwd: string, root?: string) =>
  findSession(piDef.session!.resume!.find!, cwd, root);
const makePiResumeTransforms = ({ sessionsRoot }: { sessionsRoot?: string } = {}) =>
  transformsFor(piDef, manifestRuntime(piDef, () => "")!, {
    private: "/x/ud/agents/pi", hooks: {}, execPath: "/x/electron",
    hcpSock: "/x/ud/hcp.sock", hcpToken: "t", tileSessionsDir: "/x/ud/sessions", home: "/home/u",
  }, { sessionRoot: sessionsRoot });

/** Write a pi session JSONL: a `session` header (type/id/cwd top-level) + a
 *  message line, with the given mtime. */
function sessionFile(root: string, rel: string, id: string, cwd: string, mtime: number): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-30T00:00:00.000Z", cwd });
  writeFileSync(p, header + "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }) + "\n");
  utimesSync(p, new Date(mtime), new Date(mtime));
}

test("isPi matches the pi binary (path/args tolerant)", () => {
  assert.equal(isPi({ cmd: "pi" }), true);
  assert.equal(isPi({ cmd: "/usr/local/bin/pi" }), true);
  assert.equal(isPi({ cmd: "pi --session abc" }), true);
  assert.equal(isPi({ cmd: "claude" }), false);
  assert.equal(isPi({ cmd: "codex" }), false);
  assert.equal(isPi({ cmd: "droid" }), false);
});

test("newestPiSessionForCwd picks the newest session matching the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  sessionFile(root, "--proj-app--/a.jsonl", "id-old", "/proj/app", 1_000_000);
  sessionFile(root, "--proj-app--/b.jsonl", "id-new", "/proj/app", 2_000_000);
  sessionFile(root, "--proj-other--/c.jsonl", "id-other", "/proj/other", 3_000_000); // newer but different cwd
  assert.equal(newestPiSessionForCwd("/proj/app", root), "id-new");
  assert.equal(newestPiSessionForCwd("/proj/other", root), "id-other");
  assert.equal(newestPiSessionForCwd("/proj/missing", root), undefined);
});

test("newestPiSessionForCwd ignores non-session header lines", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  // A file whose first line is NOT a pi session header (e.g. a stray jsonl) is skipped.
  mkdirSync(join(root, "--w--"), { recursive: true });
  writeFileSync(join(root, "--w--", "junk.jsonl"), JSON.stringify({ type: "message" }) + "\n");
  assert.equal(newestPiSessionForCwd("/w", root), undefined);
});

test("transformSpecOnRestore appends `--session <id>` for pi with a matching session", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  sessionFile(root, "--w--/x.jsonl", "sid-1", "/w", 1_000_000);
  const { transformSpecOnRestore } = makePiResumeTransforms({ sessionsRoot: root });
  const out = transformSpecOnRestore(
    { cwd: "/w", cmd: "pi", args: ["--model", "sonnet"] },
    "tile-1",
  );
  // existing top-level flags stay BEFORE what a launch adds: the bridge extension, then
  // the session to resume.
  assert.deepEqual(out.args, ["--model", "sonnet", "-e", "/x/ud/agents/pi/hive-pi-ext.mjs", "--session", "sid-1"]);
});

test("transformSpecOnRestore is a no-op for non-pi and for unknown cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  const { transformSpecOnRestore } = makePiResumeTransforms({ sessionsRoot: root });
  const claude = { cwd: "/w", cmd: "claude", args: ["--resume", "u"] };
  assert.deepEqual(transformSpecOnRestore(claude, "t"), claude);
  // nothing to resume, but the bridge extension still goes on: that is the launch, not the resume
  const piNoSession = { cwd: "/w", cmd: "pi", args: ["--thinking", "high"] };
  assert.deepEqual(transformSpecOnRestore(piNoSession, "t").args, ["--thinking", "high", "-e", "/x/ud/agents/pi/hive-pi-ext.mjs"]);
});

test("transformSpecOnRestore does not double-append when already resuming", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sess-"));
  sessionFile(root, "--w--/x.jsonl", "sid-1", "/w", 1_000_000);
  const { transformSpecOnRestore } = makePiResumeTransforms({ sessionsRoot: root });
  const already = transformSpecOnRestore({ cwd: "/w", cmd: "pi", args: ["--session", "old"] }, "t");
  assert.deepEqual(already.args, ["--session", "old", "-e", "/x/ud/agents/pi/hive-pi-ext.mjs"]);
});

test("restoreRetryTransform strips --session AND its value so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makePiResumeTransforms({ sessionsRoot: "/nonexistent" });
  const out = restoreRetryTransform({ cwd: "/w", cmd: "pi", args: ["--model", "sonnet", "--session", "sid"] });
  assert.deepEqual(out?.args, ["--model", "sonnet"]);
  // non-pi is not this provider's concern
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "claude", args: ["--session", "u"] }), null);
  // pi without --session → nothing to retry
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "pi", args: ["--thinking", "high"] }), null);
});
