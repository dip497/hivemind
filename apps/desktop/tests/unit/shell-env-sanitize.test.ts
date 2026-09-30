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

test("PATH rescue: prepends missing user-install dirs (the npm-global claude/codex case)", () => {
  // Desktop-launched hivemind inherits /etc/environment's PATH; the user's
  // npm -g prefix (~/.npm-global/bin, where claude and codex live) is missing.
  const env = sanitizeShellEnv({
    HOME: "/home/u",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin",
  });
  const dirs = env.PATH!.split(":");
  assert.ok(dirs.includes("/home/u/.npm-global/bin"), "npm-global dir rescued");
  assert.ok(dirs.includes("/home/u/.local/bin"), ".local/bin rescued");
  assert.ok(dirs.includes("/home/u/bin"), "~/bin rescued");
  assert.equal(dirs[0], "/home/u/bin"); // rescue dirs come first
  assert.equal(dirs[3], "/usr/local/sbin"); // existing entries keep their order
});

test("PATH rescue: never duplicates or reorders entries already present", () => {
  const before = "/home/u/.local/bin:/home/u/.npm-global/bin:/usr/bin:/home/u/bin";
  const env = sanitizeShellEnv({ HOME: "/home/u", PATH: before });
  assert.equal(env.PATH, before);
});

test("PATH rescue: skipped without HOME or a colon-separated PATH", () => {
  assert.equal(sanitizeShellEnv({ PATH: "/usr/bin" }).PATH, "/usr/bin");
  assert.equal(sanitizeShellEnv({ HOME: "/home/u" }).PATH, undefined);
});
