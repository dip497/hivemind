// The leak fix: ELECTRON_RUN_AS_NODE must never reach a terminal tile's shell,
// else launching any Electron app (hivemind, VS Code) from that terminal runs it
// in node-mode and crashes ("Cannot read properties of undefined (reading
// 'exports')").
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeShellEnv } from "@hivemind/agent-host/shell-env";
import { envToUnset } from "@hivemind/agents";
import { useAuthoredAgents } from "./authored-agents.ts";

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

test("strips what installed agents list as theirs to keep out of a terminal", () => {
  // The app launched from inside an agent's session would hand every tile that agent's
  // "you are my child" marker; claude's own manifest names its marker.
  useAuthoredAgents();
  assert.ok(envToUnset().includes("CLAUDE_CODE_CHILD_SESSION"));
  const env = sanitizeShellEnv({ CLAUDE_CODE_CHILD_SESSION: "1", HOME: "/home/x" }, envToUnset());
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(env.HOME, "/home/x");
});

test("mutates and returns the same object (chaining)", () => {
  const env = { ELECTRON_RUN_AS_NODE: "1", MARKER: "1", X: "y" };
  assert.equal(sanitizeShellEnv(env, ["MARKER"]), env);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.MARKER, undefined);
});

// The harness-location rescue: a desktop-launched hivemind inherits
// /etc/environment's PATH, so bare agent commands can resolve to a same-named
// system launcher the user never means (a broken snap shim was the incident).
test("rescue: prepends missing user-level agent bin dirs to a system PATH", () => {
  const env = sanitizeShellEnv({ HOME: "/home/u", PATH: "/usr/bin:/snap/bin" });
  assert.ok(env.PATH.startsWith("/home/u/.local/bin:/home/u/.npm-global/bin:/home/u/bin:"));
});

test("rescue: never re-orders PATH entries that are already present", () => {
  const p = "/usr/bin:/home/u/.npm-global/bin:/snap/bin";
  const env = sanitizeShellEnv({ HOME: "/home/u", PATH: p });
  assert.equal(env.PATH, `/home/u/.local/bin:/home/u/bin:${p}`);
});

test("rescue: a shell-resolved PATH containing the first-priority dirs only adds what's missing", () => {
  // ~/.npm-global/bin is present; ~/.local/bin + ~/bin are not and get prepended.
  const p = "/home/u/.npm-global/bin:/usr/bin";
  assert.equal(sanitizeShellEnv({ HOME: "/home/u", PATH: p }).PATH, `/home/u/.local/bin:/home/u/bin:${p}`);
});

test("rescue: no HOME or empty PATH is a no-op", () => {
  assert.equal(sanitizeShellEnv({ PATH: "/usr/bin" }).PATH, "/usr/bin");
  assert.equal(sanitizeShellEnv({ HOME: "/home/u" }).PATH, undefined);
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
