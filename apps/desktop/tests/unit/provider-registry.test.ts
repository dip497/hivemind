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
