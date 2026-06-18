/**
 * PlanReviewTile — the in-canvas plan review surface. Opened automatically when
 * an agent hands off a plan (the injected PreToolUse/ExitPlanMode hook → main's
 * plan-bridge → "plan-review:open"). The agent is BLOCKED on the hook connection
 * until the user decides here:
 *   - Approve plan      → resolve `allow`; the agent exits plan mode and executes.
 *   - Request changes   → resolve `deny` + feedback markdown; the agent stays in
 *                         plan mode and revises (feedback becomes
 *                         `permissionDecisionReason`).
 *
 * The tile is a thin shell: header + decision plumbing. PlanReviewBody owns the
 * block rendering + annotation engine + the Approve/Request-changes actions.
 */
import { useState } from "react";
import { GripVertical } from "lucide-react";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import { PlanReviewBody } from "./plan-review/PlanReviewBody";

interface Props {
  /** Set when the review came from the plan-bridge hook (PreToolUse). */
  requestId?: string;
  /** Set when the review came from a blocked HCP `review.open` caller. */
  hcpCmdId?: string;
  plan: string;
  cwd: string;
  /** The agent tile that produced this plan (reserved for future labeling). */
  agentTileId?: string;
  /** Remove the tile from the canvas after a decision (or external abort). */
  onClose?: () => void;
}

export function PlanReviewTile({ requestId, hcpCmdId, plan, cwd, onClose }: Props) {
  const font = useTileFont(`plan:${requestId ?? hcpCmdId ?? "x"}`, 13);
  const [sent, setSent] = useState(false);

  const decide = async (decision: "allow" | "deny", feedback?: string) => {
    if (sent) return;
    setSent(true);
    try {
      // HCP review.open → resolve the blocked caller; else the plan-bridge hook.
      if (hcpCmdId) await window.hive.hcpResult(hcpCmdId, true, { decision, feedback });
      else if (requestId) await window.hive.planReviewDecide(requestId, decision, feedback);
    } catch {
      /* main gone — the hook fails open on its side, nothing to recover here */
    }
    onClose?.();
  };

  const folder = cwd ? cwd.split("/").filter(Boolean).pop() : "";

  return (
    <div
      className="flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Plan review</span>
        {folder && <span className="text-[var(--color-fg3)] truncate">· {folder}</span>}
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <button
          className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] cursor-pointer"
          aria-label="dismiss plan review (approves the plan)"
          title="dismiss (approves)"
          onClick={() => decide("allow")}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>

      <PlanReviewBody plan={plan} fontScale={font.size / 13} sent={sent} onDecide={decide} />
    </div>
  );
}
