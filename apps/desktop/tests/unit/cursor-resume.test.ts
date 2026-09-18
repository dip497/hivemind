// cursor-resume — resolve the newest chat id for a cwd + restore transforms.
// The store layout (~/.cursor/chats/<md5(cwd)>/<chatId>/meta.json) was verified
// against a real cursor-agent 2026.09.08 store: every chat directory on that
// machine matched md5 of a real workspace path, none unmatched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// cursor resumes because its manifest says where its chats live — no code of its own.
const { findSession, resumeFromManifest, specIsAgent } = await import("@hivemind/agents/node");
const { bundledAgent } = await import("@hivemind/agents");
const cursorDef = bundledAgent("cursor");
const find = cursorDef.session!.resume!.find!;
const isCursor = (spec: { cmd: string }) => specIsAgent(cursorDef, spec);
const workspaceKey = (cwd: string) => createHash("md5").update(cwd).digest("hex");
const newestCursorChatForCwd = (cwd: string, root?: string) => findSession(find, cwd, root);
const makeCursorResumeTransforms = (root?: string) => resumeFromManifest(cursorDef, root)!;

function chat(root: string, cwd: string, id: string, updatedAtMs: number, hasConversation = true): void {
  const p = join(root, workspaceKey(cwd), id);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, updatedAtMs, hasConversation }));
}

test("isCursor matches the agent binary, never the Cursor IDE", () => {
  assert.equal(isCursor({ cmd: "cursor-agent" }), true);
  assert.equal(isCursor({ cmd: "/home/u/.local/bin/cursor-agent --force" }), true);
  assert.equal(isCursor({ cmd: "cursor" }), false); // the IDE, a different product
  assert.equal(isCursor({ cmd: "codex" }), false);
});

test("workspaceKey is the hex md5 of the absolute cwd", () => {
  const cwd = "/home/dipendra-sharma";
  assert.equal(workspaceKey(cwd), createHash("md5").update(cwd).digest("hex"));
  // the value observed in a real store for that path
  assert.equal(workspaceKey(cwd), "f6097d9e369288f7069552e574fdee27");
});

test("newestCursorChatForCwd picks the most recently updated chat with a conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-chats-"));
  chat(root, "/proj/app", "id-old", 1_000);
  chat(root, "/proj/app", "id-new", 2_000);
  chat(root, "/proj/app", "id-newest-but-empty", 3_000, false); // opened, never used
  chat(root, "/proj/other", "id-other", 9_000);
  assert.equal(newestCursorChatForCwd("/proj/app", root), "id-new");
  assert.equal(newestCursorChatForCwd("/proj/other", root), "id-other");
  assert.equal(newestCursorChatForCwd("/proj/missing", root), undefined);
});

test("transformSpecOnRestore appends `--resume <chatId>`, and is a no-op otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "cursor-chats-"));
  chat(root, "/w", "cid-1", 5_000);
  const { transformSpecOnRestore } = makeCursorResumeTransforms(root);
  assert.deepEqual(
    transformSpecOnRestore({ cwd: "/w", cmd: "cursor-agent", args: ["--force"] }, "t").args,
    ["--force", "--resume", "cid-1"],
  );
  // already resuming → untouched
  const resuming = { cwd: "/w", cmd: "cursor-agent", args: ["--resume", "other"] };
  assert.deepEqual(transformSpecOnRestore(resuming, "t"), resuming);
  // not cursor → untouched
  const codex = { cwd: "/w", cmd: "codex", args: ["resume", "x"] };
  assert.deepEqual(transformSpecOnRestore(codex, "t"), codex);
  // no chat for this cwd → fresh start
  assert.deepEqual(transformSpecOnRestore({ cwd: "/nope", cmd: "cursor-agent", args: [] }, "t").args, []);
});

test("restoreRetryTransform drops the flag AND its value so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makeCursorResumeTransforms("/nonexistent");
  const out = restoreRetryTransform({ cwd: "/w", cmd: "cursor-agent", args: ["--force", "--resume", "cid", "--model", "gpt-5"] });
  assert.deepEqual(out?.args, ["--force", "--model", "gpt-5"]);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "codex", args: ["resume", "x"] }), null);
  // `--resume` takes an OPTIONAL chat id, so a bare one must not swallow the
  // next flag off a user-authored command line.
  assert.deepEqual(
    restoreRetryTransform({ cwd: "/w", cmd: "cursor-agent", args: ["--resume", "--force"] })?.args,
    ["--force"],
  );
  assert.deepEqual(
    restoreRetryTransform({ cwd: "/w", cmd: "cursor-agent", args: ["--resume"] })?.args,
    [],
  );
});
