import { describe, expect, test } from "bun:test";
import { hookSignals, parseAgentEvent } from "../src/events.js";
import { renderHookEvents } from "../src/hooks.js";
import { hookPathsFor } from "../src/node.js";
import { agentDisclosures, defFromManifest } from "../src/manifest.js";
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

describe("an entry that hands over the turn's reply", () => {
  test("names the payload's field on a turn end, and its command is told it with the key kept", () => {
    const def = defFromManifest(manifest({ Stop: { emit: "turn.ended", reply: "last_assistant_message" } }));
    expect(def.hooks!.events.Stop).toEqual({ emit: "turn.ended", reply: "last_assistant_message" });
    const cmd = (renderHookEvents(def.hooks!, req()).Stop as Array<{ hooks: Array<{ command: string }> }>)[0]!.hooks[0]!.command;
    expect(cmd).toContain("HIVE_EVENT_REPLY='last_assistant_message' HIVE_EVENT_KEEP='session_id,agent_id,background_tasks,last_assistant_message'");
  });

  test("refused: on another event, a script or something not a field path; and without the launch that gives the agent its token", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["another event", { UserPromptSubmit: { emit: "turn.started", reply: "prompt" } }],
      ["a script", { Stop: { hook: "stop", reply: "last_assistant_message" } }],
      ["no field path", { Stop: { emit: "turn.ended", reply: "../x" } }],
    ];
    for (const [why, events] of bad) expect(() => defFromManifest(manifest(events)), why).toThrow();
    const { launch: _l, ...unlaunched } = manifest({ Stop: { emit: "turn.ended", reply: "last_assistant_message" } });
    expect(() => defFromManifest({ ...unlaunched, caps: { ...base.caps, turnSignal: false, supervise: "none" } })).toThrow(/reports \(emit\) needs launch.hcp/);
  });
});

test("an entry that reports is refused without the launch that gives the agent its tile's token, which every report signs in with", () => {
  const events = { SessionStart: { emit: "session.started" } };
  expect(defFromManifest(manifest(events)).hooks!.events.SessionStart).toEqual({ emit: "session.started" });
  const { launch: _l, ...unlaunched } = manifest(events);
  expect(() => defFromManifest({ ...unlaunched, caps: { ...base.caps, turnSignal: false, supervise: "none" } })).toThrow(/reports \(emit\) needs launch.hcp/);
});

/** What Claude Code's PermissionRequest hook prints to answer, as its entry declares it. */
const ANSWER = {
  allow: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } },
  deny: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "{message}" } } },
  choose: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: "{input}" } } },
  asks: { list: "questions", question: "question", options: "options", label: "label" },
  chosen: "answers",
  leave: ["ExitPlanMode"],
};

describe("an entry that answers what it reports", () => {
  test("is declared on the event that asks, and kept whole", () => {
    const def = defFromManifest(manifest({ PermissionRequest: { emit: "input.requested", kind: "permission", timeout: 3600, answer: ANSWER } }));
    expect(def.hooks!.events.PermissionRequest).toEqual({ emit: "input.requested", kind: "permission", timeout: 3600, answer: ANSWER });
    const { choose: _c, asks: _a, chosen: _ch, leave: _l, ...decides } = ANSWER;
    expect(() => defFromManifest(manifest({ PermissionRequest: { emit: "input.requested", answer: decides } })), "allow and deny alone").not.toThrow();
  });

  test("refused: on another event or a script, without allow or deny, a print that is no map, choosing without reading the questions or reading them from no field, a tool list that is not names, a key it does not know", () => {
    const { choose: _c, ...noChoose } = ANSWER;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["another event", { Stop: { emit: "turn.ended", answer: ANSWER } }],
      ["a script", { PermissionRequest: { hook: "approve", answer: ANSWER } }],
      ["no deny", { PermissionRequest: { emit: "input.requested", answer: { allow: ANSWER.allow } } }],
      ["a string", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, allow: "{\"behavior\":\"allow\"}" } } }],
      ["choose, no asks", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, asks: undefined } } }],
      ["choose, nowhere to set it", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, chosen: "" } } }],
      ["asks without choose", { PermissionRequest: { emit: "input.requested", answer: noChoose } }],
      ["an option's description not where it is", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, asks: { ...ANSWER.asks, description: 1 } } } }],
      ["several answers not where it is", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, asks: { ...ANSWER.asks, many: true } } } }],
      ["leave", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, leave: "ExitPlanMode" } } }],
      ["unknown", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, always: ANSWER.allow } } }],
    ];
    for (const [why, events] of bad) expect(() => defFromManifest(manifest(events)), why).toThrow();
  });

  test("is disclosed: an answer from another device allows or denies what it asks", () => {
    const says = (events: Record<string, unknown>) => agentDisclosures(defFromManifest(manifest(events))).filter((l) => /allow or deny/.test(l));
    expect(says({ PermissionRequest: { emit: "input.requested", kind: "permission", answer: ANSWER } })).toHaveLength(1);
    expect(says({ PermissionRequest: { emit: "input.requested", kind: "permission" } })).toHaveLength(0);
  });

  test("runs the generic script told to wait for the answer", () => {
    const hooks: AgentHooks = { arg: "--settings", events: { PermissionRequest: { emit: "input.requested", kind: "permission", timeout: 3600, answer: ANSWER } } };
    const cmd = ((renderHookEvents(hooks, req())!.PermissionRequest![0] as { hooks: Array<{ command: string }> }).hooks[0]!).command;
    expect(cmd).toBe("env HIVEMIND_TILE='tile-1' HIVE_EVENT='input.requested' HIVE_EVENT_KIND='permission' HIVE_EVENT_ANSWER='1' HIVE_EVENT_KEEP='session_id,agent_id,background_tasks,hook_event_name,tool_name,tool_input' ELECTRON_RUN_AS_NODE=1 '/app/hive' '/ud/hcp-event-hook.cjs' '/ud/hcp.sock'");
  });
});

describe("rendering", () => {
  test("an emit entry runs the generic script with the event in its environment", () => {
    const hooks: AgentHooks = { arg: "--settings", events: { StopFailure: { emit: "turn.ended", outcome: "failed", timeout: 10 } } };
    const out = renderHookEvents(hooks, req())!;
    const cmd = (out.StopFailure![0] as { hooks: Array<{ command: string; timeout: number }> }).hooks[0]!;
    expect(cmd.command).toBe("env HIVEMIND_TILE='tile-1' HIVE_EVENT='turn.ended' HIVE_EVENT_OUTCOME='failed' ELECTRON_RUN_AS_NODE=1 '/app/hive' '/ud/hcp-event-hook.cjs' '/ud/hcp.sock'");
    expect(cmd.timeout).toBe(10);
  });

  test("with the daemon's native hook, an emit entry runs it, told the same, with no runtime in front", () => {
    const hooks: AgentHooks = { arg: "--settings", events: { PermissionRequest: { emit: "input.requested", kind: "permission", answer: ANSWER } } };
    const def = defFromManifest(manifest({}));
    const ctx = { execPath: "/app/hive", trackerPath: "/ud/t.cjs", tileSessionsDir: "/ud/ts", eventHookPath: "/ud/hcp-event-hook.cjs", hcpSock: "/ud/hcp.sock", hookBin: "/app/hive-net", hookDoor: "/ud/hook-door.sock" };
    const native = req({ paths: { ...req().paths, hooks: hookPathsFor(def, ctx) } });
    const cmd = ((renderHookEvents(hooks, native)!.PermissionRequest![0] as { hooks: Array<{ command: string }> }).hooks[0]!).command;
    expect(cmd).toBe("env HIVEMIND_TILE='tile-1' HIVE_EVENT='input.requested' HIVE_EVENT_KIND='permission' HIVE_EVENT_ANSWER='1' HIVE_EVENT_KEEP='session_id,agent_id,background_tasks,hook_event_name,tool_name,tool_input' '/app/hive-net' 'hook' '/ud/hook-door.sock'");
    const { hookBin: _b, ...noDoor } = ctx;
    expect(hookPathsFor(def, noDoor).event, "no hive-net: the script").toEqual({ path: "/ud/hcp-event-hook.cjs", arg: "/ud/hcp.sock" });
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

  test("names a session only by an id, never by what a restart would read as a flag or a path", () => {
    expect(parseAgentEvent({ tileId: "t", event: "session.started", sessionId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" })?.sessionId).toBe("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d");
    for (const sessionId of ["--dangerously-skip-permissions", "../../etc/passwd", "a b", ""]) {
      expect(parseAgentEvent({ tileId: "t", event: "session.started", sessionId })).toEqual({ tileId: "t", event: "session.started" });
    }
  });
});
