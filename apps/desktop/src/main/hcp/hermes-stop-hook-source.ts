/**
 * Hermes-specific HCP hook sources — built on the shared {@link eventHookSource}
 * skeleton. Two variants differ from the claude hook scripts:
 *
 *  1. TURN (post_llm_call): hermes shell hooks receive
 *     `{hook_event_name, session_id, cwd, extra:{…}}` and post_llm_call carries
 *     `extra.assistant_response` (the finalized reply). Like pi, hermes has no
 *     claude-style transcript file — the reply rides the turn event itself, so
 *     agent.read returns it directly (no transcript scrape).
 *     on_session_end is deliberately NOT wired: it fires after post_llm_call in
 *     the same turn and would double-record the turn. An errored turn skips
 *     post_llm_call (hermes gates it on a non-empty final_response); the scrape
 *     + pre_llm_call self-heal cover that case.
 *  2. NEEDS-YOU (pre_approval_request): hermes's approval payload
 *     (`extra.command/description/surface`) has no claude `notification_type`,
 *     so the shared notification mapper would drop it. Map to a fixed
 *     "permission" type — hermes's approval gate is a dangerous-command prompt.
 */
import { eventHookSource } from "./event-hook-source.js";

export function hermesStopHookSource(): string {
  return eventHookSource(
    "turn",
    `var txt = (evt && evt.extra && evt.extra.assistant_response) || null;
     return { tileId: tileId, transcriptPath: null, text: txt };`,
  );
}

export function hermesNotifyHookSource(): string {
  return eventHookSource(
    "notification",
    `var cmd = (evt && evt.extra && evt.extra.command) || (evt && evt.extra && evt.extra.description) || "";
     return { tileId: tileId, notificationType: "permission", message: String(cmd) };`,
  );
}
