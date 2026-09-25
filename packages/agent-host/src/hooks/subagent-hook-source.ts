/**
 * The `SubagentStart` / `SubagentStop` hook source — emitted to disk as
 * `hcp-subagent-hook.cjs`, run by `claude` when it dispatches a Task subagent and
 * when that subagent finishes. It reports the lifecycle edge to the HCP socket so
 * main can mark the SPAWNING tile "working" while subagents are in flight —
 * including BACKGROUND agents, where claude's main loop returns to the idle
 * prompt and the screen-scrape would otherwise read "idle".
 *
 * Deterministic, version-proof (a stable hook contract, not a UI string) and
 * correctly attributed: the hook runs inside the parent tile's own session, so
 * HIVEMIND_TILE identifies exactly which tile owns the subagent.
 *
 * Built on the shared {@link eventHookSource} skeleton. One hook registered for
 * BOTH events; the phase is derived from the payload's `hook_event_name`, keyed
 * by `agent_id` so main tracks a Set (robust against a missed/duplicate edge —
 * counting can't drift). An unrecognized event maps to null → nothing is sent.
 */
import { eventHookSource } from "./event-hook-source.js";

export function subagentHookSource(): string {
  return eventHookSource(
    "subagent",
    `var ev = (evt && evt.hook_event_name) || "";
     var phase = ev === "SubagentStart" ? "start" : ev === "SubagentStop" ? "stop" : "";
     if (!phase) return null;
     var agentId = (evt && (evt.agent_id != null ? String(evt.agent_id) : "")) || "";
     return { tileId: tileId, phase: phase, agentId: agentId };`,
  );
}
