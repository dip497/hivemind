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
