// Unit test for the agent-provider registry. Run: pnpm test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerFor, composeResume, PROVIDERS } from "../../src/main/providers/registry.ts";
import type { SpawnSpec } from "../../src/main/pty-session-manager.ts";

const ctx = {
  execPath: "/x/node",
  trackerPath: "/x/tracker.cjs",
  tileSessionsDir: "/x/sess",
  stopHookPath: "/x/stop.cjs",
  subagentHookPath: "/x/sub.cjs",
  notificationHookPath: "/x/notif.cjs",
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
  assert.ok(settings.hooks.Notification, "Notification hook injected");
  assert.ok(settings.hooks.SessionStart, "SessionStart tracker injected");
});

// ── PLAN MODE ────────────────────────────────────────────────────────────────
// The PreToolUse(ExitPlanMode) hook IS plan mode: when claude finishes planning
// and calls ExitPlanMode, this hook routes the plan to the in-canvas review tile
// and blocks the agent on the decision. It's injected only when BOTH
// planHookPath AND planBridgeSock are threaded (claude.ts → claude-resume.ts).
// If a refactor drops either thread, plan mode silently stops working with no
// failing test — these two lock the wiring.
test("composeResume injects the ExitPlanMode plan-review hook when planHookPath + planBridgeSock are set", () => {
  const r = composeResume({ ...ctx, planHookPath: "/x/plan-hook.cjs", planBridgeSock: "/x/plan-bridge.sock" });
  const out = r.transformSpecOnSpawn(spec("claude"), "t1");
  const settings = JSON.parse(out.args[out.args.indexOf("--settings") + 1]!);
  const pre = settings.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
  assert.ok(Array.isArray(pre), "PreToolUse hooks present");
  const planHook = pre.find((h) => h.matcher === "ExitPlanMode");
  assert.ok(planHook, "ExitPlanMode PreToolUse hook injected — this is the plan-review handoff");
  const cmd = planHook!.hooks[0]!.command;
  assert.match(cmd, /plan-hook\.cjs/, "hook runs the plan-review hook script");
  assert.match(cmd, /plan-bridge\.sock/, "hook targets the plan-bridge socket");
});

test("composeResume does NOT inject the plan hook when planHookPath/planBridgeSock are absent", () => {
  const r = composeResume(ctx); // no plan deps
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

test("registry order is claude before codex (preserves restore chaining)", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["claude", "codex", "droid"]);
});
