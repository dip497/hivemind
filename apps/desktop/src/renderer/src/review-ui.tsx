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

export { QUICK_LABELS };

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
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
          if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder="Comment… (⌘/Ctrl+Enter)"
        className="nodrag w-full resize-y bg-[var(--color-bg)] border border-[var(--color-line2)] rounded px-2 py-1.5 text-[12px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)] placeholder:text-[var(--color-fg3)]"
      />
      <div className="flex items-center gap-1">
        <button onClick={onCancel} className="nodrag px-2 py-1 text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] cursor-pointer">
          {cancelLabel}
        </button>
        <button
          onClick={onSubmit}
          disabled={!value.trim()}
          className="nodrag ml-auto px-2.5 py-1 text-[11.5px] font-medium text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40 cursor-pointer"
        >
          {submitLabel}
        </button>
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
    <button
      onClick={onClick}
      className={`nodrag inline-flex items-center gap-1 px-2 py-1 rounded text-[11.5px] font-medium cursor-pointer transition-colors ${
        danger
          ? "text-[var(--color-danger,#e5484d)] hover:bg-[var(--color-danger,#e5484d)]/12"
          : "text-[var(--color-fg)] hover:bg-[var(--color-bg)]"
      }`}
    >
      {icon}
      {label}
    </button>
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
          <button
            key={q.label}
            onClick={() => onQuickLabel(q.label, q.tip)}
            title={q.tip}
            className="nodrag inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-[var(--color-fg2)] bg-[var(--color-bg)] border border-[var(--color-line2)] hover:border-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer"
          >
            <Tag size={9} />
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}
