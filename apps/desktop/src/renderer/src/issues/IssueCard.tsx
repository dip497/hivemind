import type { DragEvent, KeyboardEvent } from "react";
import { Play } from "lucide-react";
import type { IssueSummary } from "@hivemind/core/types";
import { StateIcon, LabelChip, Avatar } from "../components/StateMeta";

/** Open the full detail peek for an issue (App.tsx listens). Carry `root` — it's
 *  authoritative, so the peek doesn't re-guess via the registry. */
export function openIssue(id: string, root: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:open-issue", { detail: { id, root } }));
}

const onActivate = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

/** Board card — id + state icon, title, labels, assignee, work button. Draggable
 *  only when the tile is focused (so it doesn't fight canvas pan). */
export function IssueCard({
  issue,
  root,
  onWork,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueSummary;
  root: string;
  onWork: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}) {
  const open = () => openIssue(issue.id, root);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open issue ${issue.id}`}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={open}
      onKeyDown={onActivate(open)}
      title={`open ${issue.id}`}
      className={`nodrag group hm-card relative overflow-hidden p-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-brand)] ${
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <StateIcon state={issue.state} size={11} />
        <span className="font-mono text-[11px] text-[var(--color-fg2)] tabular-nums">{issue.id}</span>
        <button
          className="nodrag ml-auto inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 text-[11px] px-1.5 py-0.5 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
          aria-label={`Spawn claude to work on ${issue.id}`}
          title="spawn claude + work on this"
          onClick={(e) => {
            e.stopPropagation();
            onWork();
          }}
        >
          <Play size={8} fill="currentColor" strokeWidth={0} aria-hidden />
          work
        </button>
      </div>
      <div className="mt-1.5 text-[12px] text-[var(--color-fg)] leading-snug line-clamp-3">{issue.title}</div>
      {(issue.labels.length > 0 || issue.assignee) && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {issue.labels.slice(0, 3).map((l) => (
            <LabelChip key={l} label={l} />
          ))}
          {issue.labels.length > 3 && (
            <span className="text-[10px] text-[var(--color-fg3)]">+{issue.labels.length - 3}</span>
          )}
          {issue.assignee && (
            <span className="ml-auto">
              <Avatar id={issue.assignee.id} size={16} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact one-line row for the list view. */
export function IssueRow({ issue, root, onWork }: { issue: IssueSummary; root: string; onWork: () => void }) {
  const open = () => openIssue(issue.id, root);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onActivate(open)}
      title={`open ${issue.id}`}
      className="nodrag group flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--color-bg3)] border border-transparent hover:border-[var(--color-line2)] cursor-pointer hm-soft"
    >
      <StateIcon state={issue.state} size={12} />
      <span className="font-mono text-[11px] text-[var(--color-fg3)] tabular-nums w-20 shrink-0">{issue.id}</span>
      <span className="text-[12px] text-[var(--color-fg)] truncate flex-1 min-w-0">{issue.title}</span>
      {issue.labels.slice(0, 2).map((l) => (
        <LabelChip key={l} label={l} />
      ))}
      {issue.assignee && <Avatar id={issue.assignee.id} size={16} />}
      <button
        className="nodrag inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 text-[10.5px] px-1.5 py-0.5 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer shrink-0 hm-soft"
        aria-label={`Spawn claude to work on ${issue.id}`}
        title="spawn claude + work on this"
        onClick={(e) => {
          e.stopPropagation();
          onWork();
        }}
      >
        <Play size={8} fill="currentColor" strokeWidth={0} aria-hidden />
        work
      </button>
    </div>
  );
}
