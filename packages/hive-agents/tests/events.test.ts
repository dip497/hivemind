import { describe, expect, test } from "bun:test";
import { hookSignals, legacyTopicsFor, parseAgentEvent } from "../src/events.js";
import { renderHookEvents } from "../src/hooks.js";
import { defFromManifest } from "../src/manifest.js";
import type { LaunchRequest } from "../src/runtime.js";
import type { AgentHooks } from "../src/types.js";
import YAML from "yaml";
import { AUTHORED, authoredYaml } from "./authored.js";

const req = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  tileId: "tile-1", cwd: "/repo", args: [], env: {}, phase: "spawn", platform: "linux",
  paths: {
    private: "/ud", execPath: "/app/hive", tileSessionsDir: "/ud/ts", home: "/home/u",
    hooks: { event: { path: "/ud/hcp-event-hook.cjs", arg: "/ud/hcp.sock" }, plan: { path: "/ud/plan.cjs", arg: "/ud/plan.sock" } },
  },
  ...over,
});

// A real published manifest, with only its hook events replaced.
const base = YAML.parse(authoredYaml(AUTHORED.find((a) => a.id === "claude")!));
const manifest = (events: Record<string, unknown>) => ({ ...base, hooks: { ...base.hooks, events } });

describe("manifest emit entries", () => {
  test("an emit entry names a canonical event, with its qualifier", () => {
    const def = defFromManifest(manifest({
      Stop: { emit: "turn.ended" },
      StopFailure: { emit: "turn.ended", outcome: "failed" },
      PermissionRequest: { emit: "input.requested", kind: "permission" },
      PreToolUse: [{ hook: "plan", matcher: "ExitPlanMode" }],
    }));
    expect(def.hooks!.events.StopFailure).toEqual({ emit: "turn.ended", outcome: "failed" });
  });

  test("the base manifest itself is valid, so each refusal below is about the entry", () => {
    expect(() => defFromManifest(manifest({ Stop: { hook: "stop" } }))).not.toThrow();
  });

  test("refused: both or neither of hook and emit, unknown events, qualifiers on the wrong event, our reserved script name", () => {
    const bad: Array<Record<string, unknown>> = [
      { Stop: { hook: "stop", emit: "turn.ended" } },
      { Stop: {} },
      { Stop: { emit: "turn.finished" } },
      { Stop: { emit: "turn.started", outcome: "done" } },
      { Stop: { emit: "turn.ended", outcome: "sad" } },
      { Stop: { emit: "turn.ended", kind: "permission" } },
      { Stop: { hook: "event" } },
    ];
    for (const events of bad) expect(() => defFromManifest(manifest(events)), JSON.stringify(events)).toThrow();
  });
});

describe("rendering", () => {
  test("an emit entry runs the generic script with the event in its environment", () => {
    const hooks: AgentHooks = { arg: "--settings", events: { StopFailure: { emit: "turn.ended", outcome: "failed", timeout: 10 } } };
    const out = renderHookEvents(hooks, req())!;
    const cmd = (out.StopFailure![0] as { hooks: Array<{ command: string; timeout: number }> }).hooks[0]!;
    expect(cmd.command).toBe("HIVEMIND_TILE='tile-1' HIVE_EVENT='turn.ended' HIVE_EVENT_OUTCOME='failed' ELECTRON_RUN_AS_NODE=1 '/app/hive' '/ud/hcp-event-hook.cjs' '/ud/hcp.sock'");
    expect(cmd.timeout).toBe(10);
  });

  test("a daemon without the generic script drops emit entries, as it drops any unknown script", () => {
    const hooks: AgentHooks = { arg: "--settings", events: { Stop: { emit: "turn.ended" } } };
    expect(renderHookEvents(hooks, req({ paths: { ...req().paths, hooks: {} } }))).toBeUndefined();
  });
});

test("what an agent can report is derived from its hooks and what its own scripts declare", () => {
  const signals = hookSignals({
    hooks: { events: {
      Stop: { hook: "turnEnd" }, SubagentStart: { emit: "subagent.started" },
      PermissionRequest: { emit: "input.requested", kind: "permission" }, PreToolUse: [{ hook: "planReview" }],
    } },
    assets: [{ name: "a.cjs", file: "a.cjs", hook: "turnEnd", produces: ["turn.ended"] }, { name: "p.cjs", file: "p.cjs", hook: "planReview" }],
  });
  expect([...signals].sort()).toEqual(["input.requested", "subagent.started", "turn.ended"]);
  expect(hookSignals({}).size).toBe(0);
});

describe("the posted event", () => {
  test("is parsed into a closed shape, with defaults for the qualifier", () => {
    expect(parseAgentEvent({ tileId: "t", event: "turn.ended", transcriptPath: "/x.jsonl", message: "agent text", extra: 1 }))
      .toEqual({ tileId: "t", event: "turn.ended", outcome: "done" });
    expect(parseAgentEvent({ tileId: "t", event: "input.requested", kind: "nonsense" })).toEqual({ tileId: "t", event: "input.requested", kind: "other" });
    expect(parseAgentEvent({ tileId: "t", event: "turn.ended", background: 2 })).toEqual({ tileId: "t", event: "turn.ended", outcome: "done", background: 2 });
    expect(parseAgentEvent({ tileId: "t", event: "turn.started", background: 2 })).toEqual({ tileId: "t", event: "turn.started" });
    expect(parseAgentEvent({ tileId: "t", event: "turn.ended", background: "3; rm -rf" })).toEqual({ tileId: "t", event: "turn.ended", outcome: "done" });
    for (const bad of [null, {}, { tileId: "", event: "turn.ended" }, { tileId: "t", event: "tool.called" }]) expect(parseAgentEvent(bad)).toBeNull();
  });

  test("bridges onto today's topics without changing their payloads", () => {
    expect(legacyTopicsFor({ tileId: "t", event: "turn.started" })).toEqual([{ topic: "status", data: { tileId: "t", state: "working" } }]);
    expect(legacyTopicsFor({ tileId: "t", event: "input.resolved" })).toEqual([{ topic: "status", data: { tileId: "t", state: "working" } }]);
    expect(legacyTopicsFor({ tileId: "t", event: "compacting.started" })).toEqual([]);
    expect(legacyTopicsFor({ tileId: "t", event: "turn.ended", outcome: "failed" })).toEqual([{ topic: "turn", data: { tileId: "t" } }]);
    expect(legacyTopicsFor({ tileId: "t", event: "input.requested", kind: "permission" })[0]!.data.notificationType).toBe("permission_prompt");
    expect(legacyTopicsFor({ tileId: "t", event: "input.requested", kind: "question" })[0]!.data.notificationType).toBe("elicitation_dialog");
    expect(legacyTopicsFor({ tileId: "t", event: "subagent.stopped", agentId: "a1" })).toEqual([{ topic: "subagent", data: { tileId: "t", phase: "stop", agentId: "a1" } }]);
    expect(legacyTopicsFor({ tileId: "t", event: "session.ended" })).toEqual([]);
  });
});
