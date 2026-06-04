// codex-resume — resolve the newest session id for a cwd + restore transforms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isCodex, newestCodexSessionForCwd, makeCodexResumeTransforms } = await import(
  "../../src/main/codex-resume.ts"
);

function sessionFile(root: string, rel: string, id: string, cwd: string, mtime: number): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  const meta = JSON.stringify({ type: "session_meta", payload: { id, cwd, originator: "codex-tui" } });
  writeFileSync(p, meta + "\n" + JSON.stringify({ type: "message" }) + "\n");
  utimesSync(p, new Date(mtime), new Date(mtime));
}

test("isCodex matches the codex binary (path/args tolerant)", () => {
  assert.equal(isCodex({ cmd: "codex" }), true);
  assert.equal(isCodex({ cmd: "/usr/local/bin/codex" }), true);
  assert.equal(isCodex({ cmd: "codex --sandbox workspace-write" }), true);
  assert.equal(isCodex({ cmd: "claude" }), false);
  assert.equal(isCodex({ cmd: "opencode" }), false);
});

test("newestCodexSessionForCwd picks the newest session matching the cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-sess-"));
  sessionFile(root, "2026/a.jsonl", "id-old", "/proj/app", 1_000_000);
  sessionFile(root, "2026/b.jsonl", "id-new", "/proj/app", 2_000_000);
  sessionFile(root, "2026/c.jsonl", "id-other", "/proj/other", 3_000_000); // newer but different cwd
  assert.equal(newestCodexSessionForCwd("/proj/app", root), "id-new");
  assert.equal(newestCodexSessionForCwd("/proj/other", root), "id-other");
  assert.equal(newestCodexSessionForCwd("/proj/missing", root), undefined);
});

test("transformSpecOnRestore appends `resume <id>` for codex with a matching session", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-sess-"));
  sessionFile(root, "x.jsonl", "sid-1", "/w", 1_000_000);
  const { transformSpecOnRestore } = makeCodexResumeTransforms(root);
  const out = transformSpecOnRestore(
    { cwd: "/w", cmd: "codex", args: ["--sandbox", "workspace-write"] },
    "tile-1",
  );
  // top-level flags stay BEFORE the resume subcommand
  assert.deepEqual(out.args, ["--sandbox", "workspace-write", "resume", "sid-1"]);
});

test("transformSpecOnRestore is a no-op for non-codex and for unknown cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-sess-"));
  const { transformSpecOnRestore } = makeCodexResumeTransforms(root);
  const claude = { cwd: "/w", cmd: "claude", args: ["--resume", "u"] };
  assert.deepEqual(transformSpecOnRestore(claude, "t"), claude);
  const codexNoSession = { cwd: "/w", cmd: "codex", args: ["-s", "read-only"] };
  assert.deepEqual(transformSpecOnRestore(codexNoSession, "t").args, ["-s", "read-only"]);
});

test("restoreRetryTransform strips the resume so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makeCodexResumeTransforms("/nonexistent");
  const out = restoreRetryTransform({ cwd: "/w", cmd: "codex", args: ["--sandbox", "workspace-write", "resume", "sid"] });
  assert.deepEqual(out?.args, ["--sandbox", "workspace-write"]);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "claude", args: ["--resume", "u"] }), null);
});
