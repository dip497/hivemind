// hermes-resume — matcher, hook config, resume transforms, env injection.
import { test } from "node:test";
import assert from "node:assert/strict";

const { isHermes, hermesHooksConfig, makeHermesResumeTransforms } =
  await import("../../src/main/hermes-resume.ts");

const DEPS = {
  execPath: "/x/electron",
  hermesHome: "/x/hermes-home",
  hermesStopHookPath: "/x/hermes-stop.cjs",
  userpromptHookPath: "/x/up.cjs",
  hermesNotifyHookPath: "/x/hermes-notify.cjs",
  hcpSock: "/x/hcp.sock",
  hcpToken: "tok",
};

test("isHermes matches the hermes binary (path/args tolerant)", () => {
  assert.equal(isHermes({ cmd: "hermes" }), true);
  assert.equal(isHermes({ cmd: "/home/u/.local/bin/hermes" }), true);
  assert.equal(isHermes({ cmd: "hermes --tui" }), true);
  assert.equal(isHermes({ cmd: "claude" }), false);
  assert.equal(isHermes({ cmd: "hermes-agent" }), false, "alias resolves via basename only");
});

test("hermesHooksConfig wires the three events with env(1)-prefixed commands", () => {
  const hooks = hermesHooksConfig(DEPS);
  assert.ok(hooks.pre_llm_call && hooks.post_llm_call && hooks.pre_approval_request, "all three events wired");
  assert.equal((hooks as Record<string, unknown>).on_session_end, undefined, "on_session_end NOT wired — would double-record the turn after post_llm_call");
  const cmd = (hooks.post_llm_call![0] as { command: string }).command;
  // shlex+shell=False: the command must be a real executable (env(1)), no VAR= prefix.
  assert.match(cmd, /^env ELECTRON_RUN_AS_NODE=1 /);
  assert.match(cmd, /hermes-stop\.cjs/);
  assert.match(cmd, /hcp\.sock/);
  assert.doesNotMatch(cmd, /HIVEMIND_TILE=/, "attribution rides the agent env, not the command");
});

test("hermesHooksConfig is empty without execPath/hcpSock (no injection)", () => {
  assert.deepEqual(hermesHooksConfig({}), {});
});

test("transformSpecOnSpawn injects HERMES_HOME + accept-hooks + HCP env", () => {
  const { transformSpecOnSpawn } = makeHermesResumeTransforms(DEPS);
  const out = transformSpecOnSpawn({ cwd: "/w", cmd: "hermes", args: [] }, "tile-7");
  assert.equal(out.env?.HERMES_HOME, "/x/hermes-home");
  assert.equal(out.env?.HERMES_ACCEPT_HOOKS, "1");
  assert.equal(out.env?.HIVE_HCP_SOCK, "/x/hcp.sock");
  assert.equal(out.env?.HCP_TOKEN, "tok");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-7");
  assert.deepEqual(out.args, [], "no arg change — hooks come from the overlay config");
});

test("transformSpecOnSpawn is a no-op for non-hermes", () => {
  const { transformSpecOnSpawn } = makeHermesResumeTransforms(DEPS);
  const claude = { cwd: "/w", cmd: "claude", args: [] };
  assert.deepEqual(transformSpecOnSpawn(claude, "t"), claude);
});

test("transformSpecOnRestore appends `--in <cwd> --resume latest` + env", () => {
  const { transformSpecOnRestore } = makeHermesResumeTransforms(DEPS);
  const out = transformSpecOnRestore({ cwd: "/w", cmd: "hermes", args: [] }, "tile-1");
  assert.deepEqual(out.args, ["--in", "/w", "--resume", "latest"]);
  assert.equal(out.env?.HERMES_HOME, "/x/hermes-home");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-1");
});

test("transformSpecOnRestore passes through an explicit --resume (still env)", () => {
  const { transformSpecOnRestore } = makeHermesResumeTransforms(DEPS);
  const already = transformSpecOnRestore({ cwd: "/w", cmd: "hermes", args: ["--resume", "abc"] }, "t");
  assert.deepEqual(already.args, ["--resume", "abc"]);
  assert.equal(already.env?.HIVEMIND_TILE, "t");
});

test("restoreRetryTransform strips --resume + paired --in so a stale store respawns fresh", () => {
  const { restoreRetryTransform } = makeHermesResumeTransforms(DEPS);
  const out = restoreRetryTransform({ cwd: "/w", cmd: "hermes", args: ["--in", "/w", "--resume", "latest"] });
  assert.deepEqual(out?.args, []);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "claude", args: ["--resume", "u"] }), null);
  assert.equal(restoreRetryTransform({ cwd: "/w", cmd: "hermes", args: [] }), null);
});
