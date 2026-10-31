/**
 * An agent's status as a fold over its canonical events and the facts the host observes itself.
 * The same inputs in the same order give the same status in every implementation — the
 * conformance cases in `conformance/status.json` pin it.
 */
import type { AgentEvent, InputKind, TurnOutcome } from "./events.js";

export const SESSION_STATES = ["idle", "working", "waiting", "done", "failed", "interrupted", "limited", "exited"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** What the host sees without the agent telling it: the process ended, the user interrupted, or
 *  its hooks went quiet for so long while it waited on background work that the wait is over. */
export type HostFact = { fact: "exited" } | { fact: "interrupt" } | { fact: "quiet" };
export type StatusInput = Pick<AgentEvent, "event" | "outcome" | "kind" | "agentId" | "background" | "awaiting" | "sessionId"> | HostFact;

export interface AgentStatus {
  state: SessionState;
  /** `waiting`: what the agent is asking for. */
  kind?: InputKind;
  /** Subagents in flight, by id. */
  subagents: string[];
  /** Background tasks the last turn left running. */
  background: number;
  /** Its turn over and still working: how many background tasks it waits to hear from. */
  awaiting?: number;
  compacting: boolean;
}

export const INITIAL_STATUS: AgentStatus = { state: "idle", subagents: [], background: 0, compacting: false };

const OUTCOME_STATE: Record<TurnOutcome, SessionState> = { done: "done", failed: "failed", interrupted: "interrupted", limited: "limited" };

/** Whether a turn's end leaves its agent working: it finished, and waits on work it started. */
export function turnEndKeepsWorking(input: Pick<AgentEvent, "outcome" | "awaiting">): boolean {
  return (input.outcome ?? "done") === "done" && (input.awaiting ?? 0) > 0;
}

export function foldStatus(s: AgentStatus, input: StatusInput): AgentStatus {
  if (s.state === "exited") return s;
  const to = (state: SessionState, kind?: InputKind): AgentStatus => {
    const { kind: _, ...rest } = s;
    return { ...rest, state, ...(kind ? { kind } : {}) };
  };
  const leaving = (state: SessionState): AgentStatus => {
    const { kind: _, awaiting: __, ...rest } = s;
    return { ...rest, state };
  };
  if ("fact" in input) {
    if (input.fact === "exited") return leaving("exited");
    if (input.fact === "quiet") return s.state === "working" && s.awaiting ? leaving("idle") : s;
    return s.state === "working" || s.state === "waiting" ? leaving("interrupted") : s;
  }
  switch (input.event) {
    case "turn.started":
      return leaving("working");
    case "turn.ended":
      return turnEndKeepsWorking(input)
        ? { ...leaving("working"), background: input.background ?? 0, awaiting: input.awaiting! }
        : { ...leaving(OUTCOME_STATE[input.outcome ?? "done"]), background: input.background ?? 0 };
    case "input.requested":
      return to("waiting", input.kind ?? "other");
    case "input.resolved":
      return s.state === "waiting" ? to("working") : s;
    case "subagent.started":
      return input.agentId && !s.subagents.includes(input.agentId) ? { ...s, subagents: [...s.subagents, input.agentId] } : s;
    case "subagent.stopped": {
      const left = input.agentId ? { ...s, subagents: s.subagents.filter((id) => id !== input.agentId) } : s;
      if (s.state !== "working" || !s.awaiting || input.awaiting === undefined) return left;
      if (input.awaiting > 0) return { ...left, awaiting: input.awaiting };
      const { awaiting: _, ...over } = left;
      return { ...over, state: "done" };
    }
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
