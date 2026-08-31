// kiro-resume — matcher, hooks/agent-config generation, spawn/restore/retry
// transforms, session-id capture via the shared tile-session tracker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isKiro, kiroHooksSettings, kiroAgentConfig, makeKiroResumeTransforms, KIRO_HIVEMIND_AGENT } =
  await import("../../src/main/kiro-resume.ts");
const { tileSessionFile } = await import("../../src/main/tile-session-store.ts");

const HOOK_DEPS = {
  execPath: "/x/electron",
  kiroHome: "/x/kiro-home",
  stopHookPath: "/x/stop.cjs",
  userpromptHookPath: "/x/up.cjs",
  kiroApprovalHookPath: "/x/approve.cjs",
  trackerPath: "/x/tracker.cjs",
  tileSessionsDir: "/x/tile-sessions",
  hcpSock: "/x/hcp.sock",
  hcpToken: "tok",
};

test("isKiro matches kiro-cli ONLY — never bare `kiro` (the IDE, a different product)", () => {
  assert.equal(isKiro({ cmd: "kiro-cli" }), true);
  assert.equal(isKiro({ cmd: "/usr/local/bin/kiro-cli" }), true);
  assert.equal(isKiro({ cmd: "kiro-cli chat --resume" }), true);
  assert.equal(isKiro({ cmd: "kiro" }), false);
  assert.equal(isKiro({ cmd: "/usr/bin/kiro" }), false);
  assert.equal(isKiro({ cmd: "claude" }), false);
});

test("kiroHooksSettings wires agentSpawn/userPromptSubmit/stop/preToolUse in kiro's shape (array of {command}, no claude-style `hooks` wrapper per event)", () => {
  const hooks = kiroHooksSettings(HOOK_DEPS);
  assert.ok(Array.isArray(hooks.agentSpawn), "agentSpawn wired (session-id capture)");
  assert.ok(Array.isArray(hooks.userPromptSubmit), "userPromptSubmit wired");
  assert.ok(Array.isArray(hooks.stop), "stop wired");
  assert.ok(Array.isArray(hooks.preToolUse), "preToolUse (supervise broker) wired");
  const stopEntry = hooks.stop[0] as { command: string };
  assert.equal((stopEntry as any).hooks, undefined, "kiro's shape has no per-event `hooks` array wrapper");
  assert.match(stopEntry.command, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(stopEntry.command, /stop\.cjs/);
  assert.match(stopEntry.command, /hcp\.sock/);
  // Attribution/supervision must NOT be baked into the shared command — they
  // ride the spawn env (HIVEMIND_TILE / HIVE_SUPERVISE), inherited into the
  // hook subprocess (see kiro-resume.ts docblock).
  assert.doesNotMatch(stopEntry.command, /HIVEMIND_TILE=/);
  const preToolUse = hooks.preToolUse[0] as { matcher: string; command: string };
  assert.equal(preToolUse.matcher, "*");
  assert.doesNotMatch(preToolUse.command, /HIVE_SUPERVISE=/);
});

test("kiroHooksSettings is empty without execPath/hcpSock (no injection)", () => {
  assert.deepEqual(kiroHooksSettings({}), {});
  assert.deepEqual(kiroHooksSettings({ execPath: "/x" }), {}, "needs the socket too");
});

test("kiroAgentConfig nests hooks under a `hooks` key and wires mcpServers.hive", () => {
  const cfg = kiroAgentConfig({ ...HOOK_DEPS, hiveCliPath: "/x/hive" }) as any;
  assert.equal(cfg.name, KIRO_HIVEMIND_AGENT);
  assert.ok(cfg.hooks && cfg.hooks.stop, "hooks nested under `hooks`");
  assert.equal(cfg.mcpServers.hive.command, "/x/hive");
  assert.deepEqual(cfg.mcpServers.hive.args, ["mcp-stdio"]);
  assert.equal(cfg.mcpServers.hive.env.HIVE_AGENT_ID, "kiro");
  // No default-on trust flag — matches the skill's anti-pattern list.
  assert.equal(cfg.allowedTools, undefined);
});

test("kiroAgentConfig omits mcpServers without a hiveCliPath, and hooks without execPath/hcpSock", () => {
  const cfg = kiroAgentConfig({}) as any;
  assert.equal(cfg.mcpServers, undefined);
  assert.equal(cfg.hooks, undefined);
});

test("transformSpecOnSpawn selects --agent hivemind after chat + injects KIRO_HOME/HCP env", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(HOOK_DEPS);
  const out = transformSpecOnSpawn({ cwd: "/w", cmd: "kiro-cli", args: [] }, "tile-7");
  assert.deepEqual(out.args, ["chat", "--agent", KIRO_HIVEMIND_AGENT]);
  assert.equal(out.env?.KIRO_HOME, "/x/kiro-home");
  assert.equal(out.env?.HIVE_HCP_SOCK, "/x/hcp.sock");
  assert.equal(out.env?.HCP_TOKEN, "tok");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-7");
});

test("transformSpecOnSpawn inserts --agent after an explicit `chat`, and skips injection without kiroHome", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(HOOK_DEPS);
  const out = transformSpecOnSpawn({ cwd: "/w", cmd: "kiro-cli", args: ["chat"] }, "t");
  assert.deepEqual(out.args, ["chat", "--agent", KIRO_HIVEMIND_AGENT]);

  const { transformSpecOnSpawn: noHome } = makeKiroResumeTransforms({ ...HOOK_DEPS, kiroHome: undefined });
  const out2 = noHome({ cwd: "/w", cmd: "kiro-cli", args: [] }, "t");
  assert.deepEqual(out2.args, [], "no home seeded → no --agent injection (best-effort degrade)");
});

test("transformSpecOnSpawn is a no-op for non-kiro", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(HOOK_DEPS);
  const claude = { cwd: "/w", cmd: "claude", args: [] };
  assert.deepEqual(transformSpecOnSpawn(claude, "t"), claude);
});

test("transformSpecOnRestore uses the captured per-tile session_id (--resume-id), not cwd scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-sess-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(tileSessionFile(dir, "tile-1"), JSON.stringify({ session_id: "sid-captured" }));
  const { transformSpecOnRestore } = makeKiroResumeTransforms({ ...HOOK_DEPS, tileSessionsDir: dir });
  const out = transformSpecOnRestore({ cwd: "/w", cmd: "kiro-cli", args: [] }, "tile-1");
  assert.deepEqual(out.args, ["chat", "--resume-id", "sid-captured", "--agent", KIRO_HIVEMIND_AGENT]);
  assert.equal(out.env?.KIRO_HOME, "/x/kiro-home");
});

test("transformSpecOnRestore falls back to bare --resume (cwd-scoped) when nothing was captured", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiro-sess-"));
  const { transformSpecOnRestore } = makeKiroResumeTransforms({ ...HOOK_DEPS, tileSessionsDir: dir });
  const out = transformSpecOnRestore({ cwd: "/w", cmd: "kiro-cli", args: [] }, "tile-unknown");
  assert.deepEqual(out.args, ["chat", "--resume", "--agent", KIRO_HIVEMIND_AGENT]);
});

test("transformSpecOnRestore leaves an already-resuming spec's resume args untouched (still injects env/agent)", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms(HOOK_DEPS);
  const out = transformSpecOnRestore({ cwd: "/w", cmd: "kiro-cli", args: ["chat", "--resume-id", "old"] }, "t");
  assert.deepEqual(out.args, ["chat", "--resume-id", "old", "--agent", KIRO_HIVEMIND_AGENT]);
  assert.equal(out.env?.KIRO_HOME, "/x/kiro-home");
});

test("transformSpecOnRestore is a no-op for non-kiro", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms(HOOK_DEPS);
  const claude = { cwd: "/w", cmd: "claude", args: ["--resume", "x"] };
  assert.deepEqual(transformSpecOnRestore(claude, "t"), claude);
});

test("restoreRetryTransform strips --resume-id <id> so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(HOOK_DEPS);
  const out = restoreRetryTransform({ cwd: "/w", cmd: "kiro-cli", args: ["chat", "--resume-id", "sid", "--agent", "hivemind"] });
  assert.deepEqual(out?.args, ["chat", "--agent", "hivemind"]);
});

test("restoreRetryTransform strips bare --resume (no value arg)", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(HOOK_DEPS);
  const out = restoreRetryTransform({ cwd: "/w", cmd: "kiro-cli", args: ["chat", "--resume", "--agent", "hivemind"] });
  assert.deepEqual(out?.args, ["chat", "--agent", "hivemind"]);
});

test("restoreRetryTransform returns null when there's nothing to strip, or for non-kiro", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(HOOK_DEPS);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "kiro-cli", args: ["chat"] }), null);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "claude", args: ["--resume", "u"] }), null);
});
