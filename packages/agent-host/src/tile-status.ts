/**
 * A session's status as tiles, lists and views show it: the host's states (status-store.ts)
 * read as the kinds they colour by. One reading, shared by the window and the control plane's
 * `hive ctl list`, so both say the same of a tile. No Node: the window imports it.
 */
import type { SessionStatus } from "./status-store.js";

export type TileStatusKind =
  | "working"
  | "idle"
  | "blocked"
  | "permission"
  | "question"
  | "exited"
  | "plan_review"        // handed off a plan — waiting for a person's review
  | "awaiting_approval"; // supervised worker — waiting for its supervisor

const WAITING: Record<NonNullable<SessionStatus["kind"]>, TileStatusKind> = {
  permission: "permission", question: "question", plan: "plan_review", approval: "awaiting_approval", other: "blocked",
};
const ENDED: Partial<Record<SessionStatus["state"], string>> = { failed: "turn failed", limited: "usage limit reached", interrupted: "interrupted" };

/**
 * A hosted status as a kind. `detail` says why a turn ended as it did; `synthetic` marks an
 * `idle` that is not the agent finishing (the user interrupted it), which is not announced.
 */
export function tileStatusOf(s: SessionStatus): { status: TileStatusKind; synthetic?: boolean; detail?: string } {
  if (s.state === "exited") return { status: "exited" };
  if (s.state === "waiting") return { status: WAITING[s.kind ?? "other"] };
  if (s.state === "working" || s.subagents.length > 0) return { status: "working" };
  const detail = ENDED[s.state];
  return { status: "idle", ...(detail ? { detail } : {}), ...(s.state === "interrupted" ? { synthetic: true } : {}) };
}
