import type { DragEvent, KeyboardEvent } from "react";
import { Play } from "@hivemind/app-ui";
import { statusById, statusOfIssue, useOpenIssue, useWorkflow, type IssueSummary } from "./data";
import { StatusIcon, LabelChip, Avatar } from "./StateMeta";

/** The status icon of an issue, in its status's colour. */
export function IssueStatusIcon({ issue, size }: { issue: Pick<IssueSummary, "state" | "status">; size: number }) {
  const wf = useWorkflow();
  return <StatusIcon status={statusById(wf, statusOfIssue(issue), issue.state)} size={size} />;
}
import { Button } from "@hivemind/app-ui";

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
  onWork,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueSummary;
  onWork: () => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: (e: DragEvent) => void;
}) {
  const openIssue = useOpenIssue();
  const open = () => openIssue(issue.id);
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
      className={`nodrag group hm-card relative overflow-hidden p-2.5 ${
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <IssueStatusIcon issue={issue} size={11} />
        <span className="font-mono text-count text-[var(--color-fg2)] tabular-nums">{issue.id}</span>
        {issue.statusName && issue.status !== issue.state && (
          <span className="text-chip text-[var(--color-fg3)] truncate" data-card-status>{issue.statusName}</span>
        )}
        <Button reveal="hidden"
          size="xs"
          className="nodrag ml-auto"
          aria-label={`Spawn claude to work on ${issue.id}`}
          title="spawn claude + work on this"
          onClick={(e) => {
            e.stopPropagation();
            onWork();
          }}
        >
          <Play fill="currentColor" strokeWidth={0} />
          work
        </Button>
      </div>
      <div className="mt-1.5 text-label text-[var(--color-fg)] leading-snug line-clamp-3">{issue.title}</div>
      {(issue.labels.length > 0 || issue.assignee) && (
        <div className="mt-2 flex items-center gap-1 flex-wrap">
          {issue.labels.slice(0, 3).map((l) => (
            <LabelChip key={l} label={l} />
          ))}
          {issue.labels.length > 3 && (
            <span className="text-chip text-[var(--color-fg3)]">+{issue.labels.length - 3}</span>
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
export function IssueRow({ issue, onWork }: { issue: IssueSummary; onWork: () => void }) {
  const openIssue = useOpenIssue();
  const open = () => openIssue(issue.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onActivate(open)}
      title={`open ${issue.id}`}
      className="nodrag group flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-[var(--color-bg3)] border border-transparent hover:border-[var(--color-line2)] cursor-pointer hm-soft"
    >
      <IssueStatusIcon issue={issue} size={12} />
      <span className="font-mono text-count text-[var(--color-fg3)] tabular-nums w-20 shrink-0">{issue.id}</span>
      <span className="text-label text-[var(--color-fg)] truncate flex-1 min-w-0">{issue.title}</span>
      {issue.labels.slice(0, 2).map((l) => (
        <LabelChip key={l} label={l} />
      ))}
      {issue.assignee && <Avatar id={issue.assignee.id} size={16} />}
      <Button reveal="hidden"
        size="xs"
        className="nodrag"
        aria-label={`Spawn claude to work on ${issue.id}`}
        title="spawn claude + work on this"
        onClick={(e) => {
          e.stopPropagation();
          onWork();
        }}
      >
        <Play fill="currentColor" strokeWidth={0} />
        work
      </Button>
    </div>
  );
}
