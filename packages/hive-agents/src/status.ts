/**
 * An agent's status as a fold over its canonical events and the facts the host observes itself.
 * The same inputs in the same order give the same status in every implementation — the
 * conformance cases in `conformance/status.json` pin it.
 */
import type { AgentEvent, InputKind, TurnOutcome } from "./events.js";

export const SESSION_STATES = ["idle", "working", "waiting", "done", "failed", "interrupted", "limited", "exited"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** What the host sees without the agent telling it: the process ended, the user interrupted. */
export type HostFact = { fact: "exited" } | { fact: "interrupt" };
export type StatusInput = Pick<AgentEvent, "event" | "outcome" | "kind" | "agentId" | "background"> | HostFact;

export interface AgentStatus {
  state: SessionState;
  /** `waiting`: what the agent is asking for. */
  kind?: InputKind;
  /** Subagents in flight, by id. */
  subagents: string[];
  /** Background tasks the last turn left running. */
  background: number;
  compacting: boolean;
}

export const INITIAL_STATUS: AgentStatus = { state: "idle", subagents: [], background: 0, compacting: false };

const OUTCOME_STATE: Record<TurnOutcome, SessionState> = { done: "done", failed: "failed", interrupted: "interrupted", limited: "limited" };

export function foldStatus(s: AgentStatus, input: StatusInput): AgentStatus {
  if (s.state === "exited") return s;
  const to = (state: SessionState, kind?: InputKind): AgentStatus => {
    const { kind: _, ...rest } = s;
    return { ...rest, state, ...(kind ? { kind } : {}) };
  };
  if ("fact" in input) {
    if (input.fact === "exited") return to("exited");
    return s.state === "working" || s.state === "waiting" ? to("interrupted") : s;
  }
  switch (input.event) {
    case "turn.started":
      return to("working");
    case "turn.ended":
      return { ...to(OUTCOME_STATE[input.outcome ?? "done"]), background: input.background ?? 0 };
    case "input.requested":
      return to("waiting", input.kind ?? "other");
    case "input.resolved":
      return s.state === "waiting" ? to("working") : s;
    case "subagent.started":
      return input.agentId && !s.subagents.includes(input.agentId) ? { ...s, subagents: [...s.subagents, input.agentId] } : s;
    case "subagent.stopped":
      return input.agentId ? { ...s, subagents: s.subagents.filter((id) => id !== input.agentId) } : s;
    case "compacting.started":
      return { ...s, compacting: true };
    case "compacting.ended":
      return { ...s, compacting: false };
    default:
      // session.* are facts for the session record, not state changes: a SessionStart can
      // arrive mid-turn (after an automatic compaction).
      return s;
  }
}
