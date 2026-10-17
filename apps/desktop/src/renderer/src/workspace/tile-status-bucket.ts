import type { TileStatusKind } from "../agent-status-bus";
import { bucketTileStatus, type TileStatusBucket } from "@hivemind/view-host/status";

/** The one place a status becomes a colour. Layers, surface bars and tile headers all read
 *  this, so no surface can say amber means "working" while another says it means "needs you". */
export const STATUS_COLOR: Record<TileStatusBucket, string> = {
  working: "var(--color-status-working)",
  blocked: "var(--color-status-attention)",
  idle: "var(--color-status-idle)",
  exited: "var(--color-status-exited)",
  unknown: "var(--color-status-idle)",
};

/** A status's colour; an exit that failed is the one place `exited` is not neutral. */
export function statusColor(s: TileStatusKind | null, opts: { failed?: boolean } = {}): string {
  if (s === "exited" && opts.failed) return "var(--color-status-failed)";
  return STATUS_COLOR[bucketTileStatus(s)];
}
