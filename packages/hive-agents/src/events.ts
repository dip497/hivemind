/**
 * The canonical agent events: one small vocabulary for what any agent can report, whatever its
 * own hook names. A manifest maps a native event to one of these (`emit:`), and the host only
 * ever reasons about these. Facts only — never text an agent wrote.
 */
import type { AgentHookEntry, AgentHooks } from "./types.js";

export const AGENT_EVENTS = [
  "session.started", "session.ready", "session.ended",
  "turn.started", "turn.ended",
  "input.requested", "input.resolved",
  "subagent.started", "subagent.stopped",
  "compacting.started", "compacting.ended",
] as const;
export type AgentEventName = (typeof AGENT_EVENTS)[number];

export const TURN_OUTCOMES = ["done", "failed", "interrupted", "limited"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const INPUT_KINDS = ["permission", "question", "plan", "approval", "other"] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** One reported event, as the generic hook script posts it (HCP topic `agent.event`). */
export interface AgentEvent {
  tileId: string;
  event: AgentEventName;
  outcome?: TurnOutcome;
  kind?: InputKind;
  /** Where the agent keeps its transcript, for reading a reply; dropped for another machine's tiles. */
  transcriptPath?: string | null;
  /** The subagent this start or stop is about. */
  agentId?: string;
  /** `turn.ended`: background tasks (shells) the agent left running — a count, never their commands. */
  background?: number;
  sessionId?: string;
}

/** The HCP topic the generic script posts. */
export const AGENT_EVENT_TOPIC = "agent.event";

/** The script an `emit` entry runs, and the environment that tells it what to report. */
export const EVENT_HOOK = "event";
export const EVENT_ENV = { event: "HIVE_EVENT", outcome: "HIVE_EVENT_OUTCOME", kind: "HIVE_EVENT_KIND" } as const;

/** What each of our named observe scripts reports, in canonical terms. Scripts that decide
 *  (plan review, approval brokers) are absent: they are control, not observation. */
export const NAMED_HOOK_EVENTS: Readonly<Record<string, readonly AgentEventName[]>> = {
  stop: ["turn.ended"],
  userPrompt: ["turn.started"],
  notification: ["input.requested"],
  subagent: ["subagent.started", "subagent.stopped"],
};

/** Every canonical event an agent's hooks can produce, from `emit` entries and named scripts. */
export function hookSignals(hooks: AgentHooks | undefined): Set<AgentEventName> {
  const out = new Set<AgentEventName>();
  for (const spec of Object.values(hooks?.events ?? {})) {
    for (const e of (Array.isArray(spec) ? spec : [spec]) as AgentHookEntry[]) {
      if (e.emit) out.add(e.emit);
      else for (const n of NAMED_HOOK_EVENTS[e.hook ?? ""] ?? []) out.add(n);
    }
  }
  return out;
}

export function isAgentEventName(v: unknown): v is AgentEventName {
  return typeof v === "string" && (AGENT_EVENTS as readonly string[]).includes(v);
}

/** Parse what the generic script posted: a closed shape, never trusted beyond it. */
export function parseAgentEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.tileId !== "string" || !d.tileId || !isAgentEventName(d.event)) return null;
  const str = (v: unknown, max = 512): string | undefined => (typeof v === "string" && v && v.length <= max ? v : undefined);
  const outcome = (TURN_OUTCOMES as readonly string[]).includes(d.outcome as string) ? (d.outcome as TurnOutcome) : undefined;
  const kind = (INPUT_KINDS as readonly string[]).includes(d.kind as string) ? (d.kind as InputKind) : undefined;
  return {
    tileId: d.tileId, event: d.event,
    ...(d.event === "turn.ended" ? { outcome: outcome ?? "done" } : {}),
    ...(d.event === "input.requested" ? { kind: kind ?? "other" } : {}),
    ...(d.transcriptPath === null ? { transcriptPath: null } : str(d.transcriptPath, 4096) ? { transcriptPath: d.transcriptPath as string } : {}),
    ...(str(d.agentId, 256) ? { agentId: d.agentId as string } : {}),
    ...(d.event === "turn.ended" && Number.isInteger(d.background) && (d.background as number) > 0 && (d.background as number) < 10_000 ? { background: d.background as number } : {}),
    ...(str(d.sessionId, 256) ? { sessionId: d.sessionId as string } : {}),
  };
}

/** The HCP topics today's handlers understand, for one canonical event. A bridge: the status
 *  store that reads canonical events directly replaces it. */
export function legacyTopicsFor(e: AgentEvent): Array<{ topic: string; data: Record<string, unknown> }> {
  switch (e.event) {
    case "turn.started":
    case "input.resolved":
      return [{ topic: "status", data: { tileId: e.tileId, state: "working" } }];
    case "turn.ended":
      return [{ topic: "turn", data: { tileId: e.tileId, transcriptPath: e.transcriptPath ?? null, ...(e.background ? { background: e.background } : {}) } }];
    case "input.requested":
      // Plan review and approvals have their own control-plane waits; these are "needs you" signals.
      return [{ topic: "notification", data: { tileId: e.tileId, notificationType: e.kind === "permission" ? "permission_prompt" : "elicitation_dialog" } }];
    case "subagent.started":
    case "subagent.stopped":
      return [{ topic: "subagent", data: { tileId: e.tileId, phase: e.event === "subagent.started" ? "start" : "stop", agentId: e.agentId ?? "" } }];
    default:
      return [];
  }
}
