// The leak fix: ELECTRON_RUN_AS_NODE must never reach a terminal tile's shell,
// else launching any Electron app (hivemind, VS Code) from that terminal runs it
// in node-mode and crashes ("Cannot read properties of undefined (reading
// 'exports')").
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeShellEnv } from "../../src/main/shell-env.ts";

test("strips ELECTRON_RUN_AS_NODE (the crash trigger)", () => {
  const env = sanitizeShellEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.PATH, "/usr/bin"); // everything else preserved
});

test("strips other Electron-internal runtime vars", () => {
  const env = sanitizeShellEnv({ ELECTRON_NO_ATTACH_CONSOLE: "1", HOME: "/home/x" });
  assert.equal(env.ELECTRON_NO_ATTACH_CONSOLE, undefined);
  assert.equal(env.HOME, "/home/x");
});

test("defaults CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 for claude tiles", () => {
  const env = sanitizeShellEnv({ A: "1", B: "2" });
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, "1");
  assert.equal(env.A, "1");
});

test("strips the inherited CLAUDE_CODE_CHILD_SESSION marker (the transcript-saving-off trigger)", () => {
  // hivemind launched from inside a Claude Code session poisons every tile
  // PTY with the child marker; claude tiles then write no transcript and
  // --resume after a restart silently fails.
  const env = sanitizeShellEnv({ CLAUDE_CODE_CHILD_SESSION: "1", HOME: "/home/x" });
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, "1");
});

test("an explicit CLAUDE_CODE_FORCE_SESSION_PERSISTENCE wins over the default", () => {
  assert.equal(sanitizeShellEnv({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "0" }).CLAUDE_CODE_FORCE_SESSION_PERSISTENCE, "0");
});

test("mutates and returns the same object (chaining)", () => {
  const env = { ELECTRON_RUN_AS_NODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", X: "y" };
  assert.equal(sanitizeShellEnv(env), env);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
});
