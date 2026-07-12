import { test } from "node:test";
import assert from "node:assert/strict";
import { applyInitialPrompt, INITIAL_PROMPT_ENV } from "../../src/shared/agent-io.ts";

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
