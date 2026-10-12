import { describe, expect, test } from "bun:test";
import { hookSignals, parseAgentEvent } from "../src/events.js";
import { renderHookEvents } from "../src/hooks.js";
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

  test("refused: on another event or a script, without allow or deny, a print that is no map, choosing without reading the questions, a tool list that is not names, a key it does not know", () => {
    const { choose: _c, ...noChoose } = ANSWER;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["another event", { Stop: { emit: "turn.ended", answer: ANSWER } }],
      ["a script", { PermissionRequest: { hook: "approve", answer: ANSWER } }],
      ["no deny", { PermissionRequest: { emit: "input.requested", answer: { allow: ANSWER.allow } } }],
      ["a string", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, allow: "{\"behavior\":\"allow\"}" } } }],
      ["choose, no asks", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, asks: undefined } } }],
      ["choose, nowhere to set it", { PermissionRequest: { emit: "input.requested", answer: { ...ANSWER, chosen: "" } } }],
      ["asks without choose", { PermissionRequest: { emit: "input.requested", answer: noChoose } }],
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
    expect(cmd).toBe("env HIVEMIND_TILE='tile-1' HIVE_EVENT='input.requested' HIVE_EVENT_KIND='permission' HIVE_EVENT_ANSWER='1' ELECTRON_RUN_AS_NODE=1 '/app/hive' '/ud/hcp-event-hook.cjs' '/ud/hcp.sock'");
  });
});

describe("an entry sent as an http hook", () => {
  const HTTP = { type: "http", url: "{url}", headers: { Authorization: "Bearer ${HCP_TOKEN}" }, allowedEnvVars: ["HCP_TOKEN"], timeout: "{timeout}" };
  const entry = { emit: "input.requested", kind: "permission", timeout: 3600, answer: ANSWER, via: "http" } as const;

  test("posts to the daemon's door, its event in the url, in the agent's own shape; a daemon without the door runs the generic script", () => {
    const hooks: AgentHooks = { arg: "--settings", http: HTTP, events: { PermissionRequest: entry } };
    const body = (r: LaunchRequest) => (renderHookEvents(hooks, r)!.PermissionRequest![0] as { hooks: Array<Record<string, unknown>> }).hooks[0];
    expect(body(req({ paths: { ...req().paths, hcpUrl: "http://127.0.0.1:4711" } }))).toEqual({
      type: "http", url: "http://127.0.0.1:4711/event?event=input.requested&kind=permission&answer=1",
      headers: { Authorization: "Bearer ${HCP_TOKEN}" }, allowedEnvVars: ["HCP_TOKEN"], timeout: 3600,
    });
    expect(body(req())).toEqual({ type: "command", command: "env HIVEMIND_TILE='tile-1' HIVE_EVENT='input.requested' HIVE_EVENT_KIND='permission' HIVE_EVENT_ANSWER='1' ELECTRON_RUN_AS_NODE=1 '/app/hive' '/ud/hcp-event-hook.cjs' '/ud/hcp.sock'", timeout: 3600 });
  });

  test("is declared with the agent's http shape, and kept", () => {
    const def = defFromManifest({ ...base, hooks: { ...base.hooks, http: HTTP, events: { PermissionRequest: entry } } });
    expect(def.hooks!.http).toEqual(HTTP);
    expect(def.hooks!.events.PermissionRequest).toEqual(entry);
  });

  test("refused: on a script, another transport, without the agent's http shape, a shape with nowhere to post", () => {
    const { http: _h, ...noHttp } = base.hooks;
    const bad: Array<[string, Record<string, unknown>]> = [
      ["a script", { ...base.hooks, http: HTTP, events: { PermissionRequest: { hook: "approve", via: "http" } } }],
      ["another transport", { ...base.hooks, http: HTTP, events: { PermissionRequest: { ...entry, via: "ws" } } }],
      ["no shape", { ...noHttp, events: { PermissionRequest: entry } }],
      ["no url", { ...base.hooks, http: { ...HTTP, url: "http://127.0.0.1" }, events: { PermissionRequest: entry } }],
    ];
    for (const [why, hooks] of bad) expect(() => defFromManifest({ ...base, hooks }), why).toThrow();
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
});
