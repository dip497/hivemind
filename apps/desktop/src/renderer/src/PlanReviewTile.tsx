/**
 * PlanReviewTile — the in-canvas plan review surface. Opened automatically when
 * an agent waits on a review of its plan (its ExitPlanMode hook, or `hive ctl
 * open-review`), in every window showing the agent, on every machine the
 * workspace is shared with. The agent waits until someone who may drive agents
 * decides here, or answers its wait elsewhere (`agent.answer`):
 *   - Approve plan      → resolve `allow`; the agent exits plan mode and executes.
 *   - Request changes   → resolve `deny` + feedback markdown; the agent stays in
 *                         plan mode and revises (feedback becomes
 *                         `permissionDecisionReason`).
 * The first answer is the one the agent gets. A guest who may not drive agents
 * reads the plan and cannot answer it.
 *
 * The tile is a thin shell: header + decision plumbing. PlanReviewBody owns the
 * block rendering + annotation engine + the Approve/Request-changes actions.
 */
import { useState } from "react";
import { toast } from "sonner";
import { GripVertical } from "./components/icons";
import { Button } from "./components/ui/button";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import { PlanReviewBody } from "./plan-review/PlanReviewBody";
import { joinedId, useShown } from "./multiplayer/shown";

interface Props {
  /** The agent waiting on the review, and when its wait began: what an answer is to. */
  agentTileId: string;
  since: number;
  plan: string;
  cwd: string;
  /** Remove the tile from the canvas after a decision (or external abort). */
  onClose?: () => void;
}

export function PlanReviewTile({ agentTileId, since, plan, cwd, onClose }: Props) {
  const font = useTileFont(`plan:${agentTileId}@${since}`, 13);
  const [sent, setSent] = useState(false);
  // In a workspace joined from elsewhere, answering is driving the host's agents.
  const { repo, shared } = useShown();
  const mayDecide = !joinedId(repo) || shared?.access === "agents";

  const decide = async (decision: "allow" | "deny", feedback?: string) => {
    if (sent) return;
    setSent(true);
    try {
      const { answered, by } = await window.hive.agentAnswer(agentTileId, since, { decision, ...(feedback ? { feedback } : {}) });
      if (!answered && by) toast(`${by.name || "Someone"} answered the plan first`);
    } catch {
      /* main gone — the hook fails open on its side, nothing to recover here */
    }
    onClose?.();
  };

  const folder = cwd ? cwd.split("/").filter(Boolean).pop() : "";

  return (
    <div
      className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[var(--hm-shadow-float)]"
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-count font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Plan review</span>
        {folder && <span className="text-[var(--color-fg3)] truncate">· {folder}</span>}
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <Button
          variant="ghost"
          size="icon-2xs"
          className="nodrag"
          aria-label={mayDecide ? "dismiss plan review (approves the plan)" : "close plan review"}
          title={mayDecide ? "dismiss (approves)" : "close"}
          onClick={() => (mayDecide ? void decide("allow") : onClose?.())}
        >
          <svg viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </Button>
      </div>

      <PlanReviewBody plan={plan} fontScale={font.size / 13} sent={sent} onDecide={mayDecide ? decide : null} />
    </div>
  );
}
