/**
 * What a view is told of a tile's status (view protocol `status`): the bucket it paints the tile
 * with, and, on an agent's tile, what the agent is doing. One reading for every host of a view and
 * for the window's own surfaces, so a tile never means one thing in a view and another on the
 * canvas. No DOM and no Node.
 */
import type { ViewAgentStatus } from "@hivemind/view-sdk/protocol";
import type { SessionStatus } from "@hivemind/agent-host/status-store";
import type { TileStatusKind } from "@hivemind/agent-host/tile-status";

/** The five colour buckets a view paints a tile with. */
export type TileStatusBucket = "idle" | "working" | "blocked" | "exited" | "unknown";

/** Bus status → bucket (every "needs you" state is `blocked`). */
export function bucketTileStatus(s: TileStatusKind | null): TileStatusBucket {
  switch (s) {
    case "working": return "working";
    case "idle": return "idle";
    case "exited": return "exited";
    case "blocked": case "permission": case "question": case "plan_review": case "awaiting_approval": return "blocked";
    default: return "unknown";
  }
}

/** A session's status as views see it: fixed words and counts, never a subagent's name. */
export function viewAgentStatus(s: SessionStatus): ViewAgentStatus {
  return {
    state: s.state,
    ...(s.state === "waiting" && s.kind ? { waitingFor: s.kind } : {}),
    subagents: s.subagents.length,
    background: s.background,
    compacting: s.compacting,
    ...(s.source ? { source: s.source } : {}),
  };
}
