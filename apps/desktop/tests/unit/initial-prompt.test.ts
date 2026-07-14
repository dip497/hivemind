import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInitialPrompt, INITIAL_PROMPT_ENV, stripInitialPrompt, deliversPromptViaArgv } from "../../src/shared/agent-io.ts";

test("applyInitialPrompt: appends the prompt as claude's trailing positional argv", () => {
  const { args } = applyInitialPrompt(
    ["--session-id", "abc", "--permission-mode", "plan"],
    { [INITIAL_PROMPT_ENV]: "Work on DEMO-1", PATH: "/usr/bin" },
  );
  // Prompt is LAST so claude reads it as the positional [prompt] (which auto-submits).
  assert.deepEqual(args, ["--session-id", "abc", "--permission-mode", "plan", "Work on DEMO-1"]);
});

test("applyInitialPrompt: strips the key from the CHILD env (claude never sees it)", () => {
  const { env } = applyInitialPrompt([], { [INITIAL_PROMPT_ENV]: "x", FOO: "1" });
  assert.equal(env[INITIAL_PROMPT_ENV], undefined);
  assert.equal(env.FOO, "1");
});

test("applyInitialPrompt: no key → argv + env pass through unchanged (safe on every spawn)", () => {
  const inArgs = ["--resume", "abc"];
  const inEnv = { PATH: "/usr/bin" };
  const { args, env } = applyInitialPrompt(inArgs, inEnv);
  assert.deepEqual(args, inArgs);
  assert.deepEqual(env, inEnv);
});

test("applyInitialPrompt: a prompt with spaces/quotes stays ONE argv element (no word-split, no injection)", () => {
  const nasty = 'Fix "total()" && rm -rf /; echo $HOME';
  const { args } = applyInitialPrompt(["--model", "opus"], { [INITIAL_PROMPT_ENV]: nasty });
  assert.equal(args.length, 3);
  assert.equal(args[2], nasty); // verbatim, not split on spaces or shell metachars
});

test("applyInitialPrompt: does not mutate its inputs", () => {
  const inArgs = ["--foo"];
  const inEnv = { [INITIAL_PROMPT_ENV]: "p" };
  applyInitialPrompt(inArgs, inEnv);
  assert.deepEqual(inArgs, ["--foo"]);
  assert.equal(inEnv[INITIAL_PROMPT_ENV], "p");
});

test("pi takes the argv prompt path too — it auto-submits it like claude", () => {
  // pi 0.55.3: main.js parses a positional message into `initialMessage`, and
  // interactive-mode calls session.prompt(initialMessage) — a real, auto-submitted
  // turn. So a spawned pi worker must NOT go through the typed-into-a-booting-TUI
  // path, which is the race that made ▶ Work silently do nothing on a cold start.
  assert.equal(deliversPromptViaArgv("claude"), true);
  assert.equal(deliversPromptViaArgv("pi"), true);
  // Unverified CLIs stay on the typed path — a wrong flag/positional breaks them.
  assert.equal(deliversPromptViaArgv("codex"), false);
  assert.equal(deliversPromptViaArgv("droid"), false);
  assert.equal(deliversPromptViaArgv("opencode"), false);
  assert.equal(deliversPromptViaArgv(undefined), false);

  // The prompt lands LAST, after pi's injected `-e <ext>` — `pi -e x.mjs "task"`.
  const { args } = applyInitialPrompt(["-e", "/u/hive-pi-ext.mjs"], { [INITIAL_PROMPT_ENV]: "do the thing" });
  assert.deepEqual(args, ["-e", "/u/hive-pi-ext.mjs", "do the thing"]);
});

test("restore strips the initial prompt for EVERY agent — else the task re-runs on every restart", () => {
  // A frozen session re-execs from its persisted spec, env included. This used to be
  // stripped inside claude-resume, which no-op'd for pi — so a restored pi worker
  // would have re-appended its prompt as argv and re-run the task, forever.
  const spec = { cmd: "pi", args: ["-e", "x.mjs"], env: { [INITIAL_PROMPT_ENV]: "task", PATH: "/usr/bin" } };
  const restored = stripInitialPrompt(spec);
  assert.equal(restored.env[INITIAL_PROMPT_ENV], undefined);
  assert.equal(restored.env.PATH, "/usr/bin", "the rest of the env survives");
  // And what the daemon re-execs carries no prompt → no duplicate turn.
  assert.deepEqual(applyInitialPrompt(restored.args, restored.env).args, ["-e", "x.mjs"]);
  // Idempotent + non-mutating.
  assert.equal(spec.env[INITIAL_PROMPT_ENV], "task");
  assert.equal(stripInitialPrompt({ cmd: "pi" }).env, undefined);
});
