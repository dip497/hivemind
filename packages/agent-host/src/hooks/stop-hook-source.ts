/**
 * The `Stop` hook source — emitted to disk as `hcp-stop-hook.cjs`, run by
 * `claude` when an agent FINISHES A TURN. It reports the finished turn (+ the
 * transcript path) to the HCP socket so a driver blocked in agent.read wakes
 * deterministically and reads the agent's reply. Does NOT block the stop.
 *
 * Built on the shared {@link eventHookSource} skeleton (connect / write-one-event
 * / fail-open); only the topic + stdin mapping is local. The Stop payload is
 * `{ transcript_path, session_id, stop_hook_active }`; we forward the transcript
 * path (always sends — a turn is always recorded, transcript or not).
 */
import { eventHookSource } from "./event-hook-source.js";

export function stopHookSource(): string {
  return eventHookSource(
    "turn",
    `return { tileId: tileId, transcriptPath: (evt && evt.transcript_path) || null };`,
  );
}
