import type { TileStatusKind } from "../agent-status-bus";

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
