/**
 * Shared review-annotation UI kit — the presentational + interaction primitives
 * used by BOTH the plan-review surface (PlanReviewBody) and the diff-comment
 * surface (DiffTile), so the two have the SAME look & feel. Domain logic
 * (anchoring, persistence, content rendering) stays in each caller; only the
 * comment popover / toolbar / cards / sizing live here.
 *
 * Sizing tokens are deliberately a bit larger than the old diff composer
 * (which used 10–11px) — they match plan mode: 13px icons, 11.5–12.5px text.
 */
import type { ReactNode } from "react";
import { MessageSquare, Trash2, Tag } from "lucide-react";
import { QUICK_LABELS } from "./plan-review/types";
import type { ReviewComment } from "./diff-comments";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

export { QUICK_LABELS };

/** Anchor a comment popover just under a clicked line, flipping above it when it
 *  would fall off the host's bottom edge. Shared by DiffTile + the Workbench diff
 *  so the composer positions identically in both. */
export function composerAnchor(
  hostEl: HTMLElement | null,
  lineEl: HTMLElement | null,
): { x: number; y: number } {
  const hostRect = hostEl?.getBoundingClientRect();
  const lineRect = lineEl?.getBoundingClientRect();
  if (!hostRect || !lineRect) return { x: 44, y: 44 };
  const yBelow = lineRect.bottom - hostRect.top;
  const flip = yBelow > hostRect.height - 150;
  return {
    x: lineRect.left - hostRect.left + 44,
    y: flip ? Math.max(4, lineRect.top - hostRect.top - 140) : yBelow,
  };
}

/** Inline diff annotation card (the rendered review comment shown under a line).
 *  Shared so DiffTile and the Workbench diff render comments identically. */
export function ReviewAnnotation({ comment: c }: { comment: ReviewComment | undefined }) {
  if (!c) return null;
  return (
    <div
      style={{
        background: "rgba(245,159,0,0.08)",
        borderLeft: "3px solid var(--color-warn)",
        padding: "5px 12px 5px 56px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        color: "var(--color-warn)",
      }}
    >
      <span style={{ color: "var(--color-fg)", fontWeight: 600 }}>{c.author}</span>
      {c.startLine !== c.endLine && (
        <span style={{ marginLeft: 6, color: "var(--color-fg3)", fontSize: 10 }}>L{c.startLine}–{c.endLine}</span>
      )}
      {c.resolved && <span style={{ marginLeft: 6, color: "var(--color-ok)", fontSize: 10 }}>✓ resolved</span>}
      <span style={{ marginLeft: 8, color: c.resolved ? "var(--color-fg3)" : undefined }}>{c.body}</span>
      {!!c.replies?.length && (
        <span style={{ marginLeft: 6, color: "var(--color-fg3)", fontSize: 10 }}>💬 {c.replies.length}</span>
      )}
      <span style={{ color: "var(--color-fg3)", float: "right", fontSize: 10 }}>{c.at}</span>
    </div>
  );
}

/** A small popover anchored within a scroll/positioned container (absolute
 *  coords relative to that container). Click-outside closes it. */
export function ReviewPopover({
  anchor,
  onClose,
  children,
}: {
  anchor: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        className="absolute z-50 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-xl p-1.5"
        style={{ left: Math.max(4, anchor.x - 60), top: anchor.y + 6 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>
  );
}

/** Multi-line comment box (⌘/Ctrl+Enter submits, Esc/Back cancels). */
export function CommentBox({
  value,
  onChange,
  onCancel,
  onSubmit,
  submitLabel = "Add",
  cancelLabel = "Back",
}: {
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  cancelLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 w-[260px]">
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder="Comment… (⌘/Ctrl+Enter)"
        className="nodrag w-full resize-y"
      />
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={onCancel} className="nodrag">
          {cancelLabel}
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!value.trim()}
          className="nodrag ml-auto"
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** One toolbar button (the choose-stage action: Comment / Delete). */
export function ToolBtn({
  icon,
  label,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant={danger ? "destructive" : "ghost"} size="xs" onClick={onClick} className="nodrag">
      {icon}
      {label}
    </Button>
  );
}

/** The "choose action" stage of the comment popover: Comment + the quick-label
 *  chips (and optionally Delete). Shared so plan-review and diff comments expose
 *  the SAME affordances. `onDelete` omitted (diff comments don't delete a line). */
export function ActionToolbar({
  onComment,
  onDelete,
  onQuickLabel,
}: {
  onComment: () => void;
  onDelete?: () => void;
  onQuickLabel: (label: string, tip?: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <ToolBtn icon={<MessageSquare size={13} />} label="Comment" onClick={onComment} />
        {onDelete && <ToolBtn icon={<Trash2 size={13} />} label="Delete" danger onClick={onDelete} />}
      </div>
      <div className="flex flex-wrap gap-1 max-w-[230px] pt-0.5">
        {QUICK_LABELS.map((q) => (
          <Button
            key={q.label}
            variant="outline"
            size="2xs"
            onClick={() => onQuickLabel(q.label, q.tip)}
            title={q.tip}
            className="nodrag"
          >
            <Tag />
            {q.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
