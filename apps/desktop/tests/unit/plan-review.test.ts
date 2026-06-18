/**
 * Plan-review spine tests — the load-bearing, electron-free pieces:
 *  1. trackerSettings injects the PreToolUse(ExitPlanMode) hook only when the
 *     plan-bridge paths are supplied (and never breaks the SessionStart hook).
 *  2. startPlanBridge round-trips a plan → decision over the unix socket.
 *  3. The GENERATED hook .cjs honors the Claude Code contract end-to-end:
 *     reads tool_input.plan, blocks on the socket, prints the right
 *     allow/deny JSON, and FAILS OPEN when the bridge is unreachable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { trackerSettings } from "../../src/main/claude-resume.ts";
import { startPlanBridge } from "../../src/main/plan-bridge.ts";
import { planHookSource } from "../../src/main/plan-review-hook-source.ts";

const baseDeps = {
  trackerPath: "/x/tracker.cjs",
  tileSessionsDir: "/x/sessions",
  execPath: "/usr/bin/node",
};

test("trackerSettings: no PreToolUse hook without plan-bridge paths", () => {
  const s = JSON.parse(trackerSettings(baseDeps, "tile-1"));
  assert.ok(s.hooks.SessionStart, "SessionStart always present");
  assert.equal(s.hooks.PreToolUse, undefined);
});

test("trackerSettings: injects PreToolUse(ExitPlanMode) with the socket + tile", () => {
  const s = JSON.parse(
    trackerSettings(
      { ...baseDeps, planHookPath: "/x/plan-hook.cjs", planBridgeSock: "/x/plan.sock" },
      "tile-42",
    ),
  );
  const pre = s.hooks.PreToolUse;
  assert.ok(Array.isArray(pre) && pre.length === 1);
  assert.equal(pre[0].matcher, "ExitPlanMode");
  const hook = pre[0].hooks[0];
  assert.equal(hook.type, "command");
  assert.equal(hook.timeout, 345600);
  assert.match(hook.command, /HIVEMIND_TILE='tile-42'/);
  assert.match(hook.command, /plan-hook\.cjs/);
  assert.match(hook.command, /plan\.sock/);
  // SessionStart must survive the merge.
  assert.ok(s.hooks.SessionStart);
});

const tmpSock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "plan-")), "plan.sock");

test("startPlanBridge: round-trips a plan → deny+feedback", async () => {
  const sock = tmpSock();
  let captured: { tileId: string; plan: string; cwd: string } | null = null;
  const bridge = startPlanBridge(sock, (req) => {
    captured = { tileId: req.tileId, plan: req.plan, cwd: req.cwd };
    req.reply("deny", "add a rollback step");
  });
  await new Promise((r) => setTimeout(r, 50)); // let listen() settle

  const reply = await new Promise<{ decision: string; feedback?: string }>((resolve, reject) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ tileId: "t1", plan: "# Plan", cwd: "/repo" }) + "\n"));
    c.setEncoding("utf8");
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
    c.on("error", reject);
  });

  assert.deepEqual(captured, { tileId: "t1", plan: "# Plan", cwd: "/repo" });
  assert.equal(reply.decision, "deny");
  assert.equal(reply.feedback, "add a rollback step");
  bridge.close();
});

/** Run the generated hook .cjs with a stdin event + env, return its stdout. */
function runHook(
  hookPath: string,
  sock: string,
  event: unknown,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, sock], {
      env: { ...process.env, HIVEMIND_TILE: "tile-hook" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code }));
    child.stdin.end(JSON.stringify(event));
  });
}

const writeHook = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planhook-"));
  const p = path.join(dir, "plan-review-hook.cjs");
  fs.writeFileSync(p, planHookSource());
  return p;
};

const PLAN_EVENT = {
  hook_event_name: "PreToolUse",
  tool_name: "ExitPlanMode",
  cwd: "/repo",
  tool_input: { plan: "## Step 1\nDo the thing." },
};

test("generated hook: deny → emits permissionDecision deny + reason", async () => {
  const sock = tmpSock();
  const bridge = startPlanBridge(sock, (req) => {
    assert.equal(req.plan, "## Step 1\nDo the thing.");
    assert.equal(req.tileId, "tile-hook");
    req.reply("deny", "split into two phases");
  });
  await new Promise((r) => setTimeout(r, 50));

  const { stdout, code } = await runHook(writeHook(), sock, PLAN_EVENT);
  bridge.close();
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, "split into two phases");
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("generated hook: approve → emits permissionDecision allow", async () => {
  const sock = tmpSock();
  const bridge = startPlanBridge(sock, (req) => req.reply("allow"));
  await new Promise((r) => setTimeout(r, 50));
  const { stdout } = await runHook(writeHook(), sock, PLAN_EVENT);
  bridge.close();
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("generated hook: FAILS OPEN (allow) when the bridge is unreachable", async () => {
  // Point at a socket nothing is listening on.
  const dead = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dead-")), "nope.sock");
  const { stdout, code } = await runHook(writeHook(), dead, PLAN_EVENT);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("generated hook: no plan in event → fail open", async () => {
  const sock = tmpSock();
  const bridge = startPlanBridge(sock, () => assert.fail("should not reach bridge without a plan"));
  await new Promise((r) => setTimeout(r, 50));
  const { stdout } = await runHook(writeHook(), sock, { tool_input: {} });
  bridge.close();
  assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "allow");
});
