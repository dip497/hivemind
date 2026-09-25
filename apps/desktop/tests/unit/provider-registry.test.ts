// Unit test for the agent-provider registry. Run: pnpm test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFor, composeResume, providers } from "@hivemind/agents/node";
import type { SpawnSpec } from "@hivemind/agent-host/pty-session-manager";
import { useAuthoredAgents } from "./authored-agents.ts";

// The providers are published manifests now; load the fixtures as an installed machine sees them.
useAuthoredAgents();

const ctx = {
  execPath: "/x/node",
  trackerPath: "/x/tracker.cjs",
  tileSessionsDir: "/x/sess",
  eventHookPath: "/x/event.cjs",
  sdkPath: "/x/hive-sdk.cjs",
  hcpSock: "/x/hcp.sock",
  hcpToken: "tok",
};
const spec = (cmd: string): SpawnSpec => ({ cwd: "/repo", cmd, args: [], cols: 80, rows: 24 });

test("providerFor matches by command basename", () => {
  assert.equal(providerFor("claude")?.id, "claude");
  assert.equal(providerFor("/usr/local/bin/claude")?.id, "claude");
  assert.equal(providerFor("codex")?.id, "codex");
  assert.equal(providerFor("/opt/codex")?.id, "codex");
  assert.equal(providerFor("droid")?.id, "droid");
  assert.equal(providerFor("/usr/local/bin/droid")?.id, "droid");
  assert.equal(providerFor("kiro-cli")?.id, "kiro");
  assert.equal(providerFor("/usr/local/bin/kiro-cli")?.id, "kiro");
  assert.equal(providerFor("kiro"), undefined, "bare `kiro` is the Kiro IDE, a different product");
  assert.equal(providerFor("pi")?.id, "pi");
  assert.equal(providerFor("/opt/pi")?.id, "pi");
  assert.equal(providerFor("bash"), undefined);
  assert.equal(providerFor(""), undefined);
});

test("composeResume injects claude's signal hooks on a fresh claude spawn", () => {
  const r = composeResume(ctx);
  const out = r.transformSpecOnSpawn(spec("claude"), "t1");
  const sIdx = out.args.indexOf("--settings");
  assert.ok(sIdx >= 0, "claude spec gains --settings");
  const settings = JSON.parse(out.args[sIdx + 1]!);
  // The composed transform wires every claude deterministic signal.
  assert.ok(settings.hooks.Stop, "Stop (turn) hook injected");
  assert.ok(settings.hooks.SubagentStart, "SubagentStart hook injected");
  assert.ok(settings.hooks.PermissionRequest, "PermissionRequest (needs you) hook injected");
  assert.ok(settings.hooks.SessionStart, "SessionStart tracker injected");
});

// ── PLAN MODE ────────────────────────────────────────────────────────────────
// The PreToolUse(ExitPlanMode) hook IS plan mode: when claude finishes planning
// and calls ExitPlanMode, this hook routes the plan to the in-canvas review tile
// and blocks the agent on the decision. It is claude's own script, run with the SDK,
// which reaches the bridge through HIVE_PLAN_SOCK. If a refactor drops the SDK or the
// socket thread, plan mode silently stops working with no failing test — these lock it.
test("composeResume injects the ExitPlanMode plan-review hook with the bridge socket", () => {
  const r = composeResume({ ...ctx, planBridgeSock: "/x/plan-bridge.sock" });
  const out = r.transformSpecOnSpawn(spec("claude"), "t1");
  const settings = JSON.parse(out.args[out.args.indexOf("--settings") + 1]!);
  const pre = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
  assert.ok(Array.isArray(pre), "PreToolUse hooks present");
  const planHook = pre.find((h) => h.matcher === "ExitPlanMode");
  assert.ok(planHook, "ExitPlanMode PreToolUse hook injected — this is the plan-review handoff");
  const cmd = planHook!.hooks[0]!.command;
  assert.match(cmd, /hive-plan-review\.cjs/, "hook runs claude's plan-review script");
  assert.match(cmd, /HIVE_PLAN_SOCK='\/x\/plan-bridge\.sock'/, "hook targets the plan-bridge socket");
});

test("composeResume does NOT inject the plan hook without the SDK", () => {
  const { sdkPath: _, ...noSdk } = ctx;
  const r = composeResume(noSdk);
  const out = r.transformSpecOnSpawn(spec("claude"), "t1");
  const settings = JSON.parse(out.args[out.args.indexOf("--settings") + 1]!);
  const planHook = ((settings.hooks.PreToolUse ?? []) as Array<{ matcher: string }>).find((h) => h.matcher === "ExitPlanMode");
  assert.equal(planHook, undefined, "no plan hook when its deps are not provided");
});

test("composeResume leaves a non-agent spec untouched (every provider no-ops)", () => {
  const r = composeResume(ctx);
  const out = r.transformSpecOnSpawn(spec("bash"), "t2");
  assert.deepEqual(out.args, []);
});

test("composeResume restoreRetryMs is the max across providers (≥ claude's 5s)", () => {
  assert.ok(composeResume(ctx).restoreRetryMs >= 5000);
});

test("every provider with a daemon half is registered, in catalog order", () => {
  // Order is immaterial (each transform no-ops on specs it doesn't own — see the
  // order-independence golden test); this pins the SET, not a chaining order.
  assert.deepEqual([...providers().map((p) => p.id)].sort(), ["claude", "codex", "cursor", "droid", "kiro", "pi"]);
});
