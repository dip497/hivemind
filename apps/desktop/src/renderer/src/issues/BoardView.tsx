import { useRef, useState } from "react";
import type { IssueSummary } from "@hivemind/core/types";
import { groupIssues, type GroupBy, type IssueGroup } from "./grouping";
import { IssueCard } from "./IssueCard";
import { useUpdateState, useUpdateIssue } from "../queries";

const canDrop = (g: IssueGroup): boolean =>
  g.dropState !== undefined || g.dropAssignee !== undefined || g.dropParent !== undefined;

/** Kanban board grouped by `groupBy`. Cards drag between columns ONLY when the
 *  tile is focused (`selected`) — otherwise a drag would fight canvas pan. A drop
 *  applies the column's single-valued field (state / assignee / parent); label
 *  columns are multi-membership and have no drop target. */
export function BoardView({
  issues,
  root,
  groupBy,
  showCancelled,
  selected,
  onWork,
}: {
  issues: IssueSummary[];
  root: string;
  groupBy: GroupBy;
  showCancelled: boolean;
  selected: boolean;
  onWork: (i: IssueSummary) => void;
}) {
  const groups = groupIssues(issues, groupBy, showCancelled);
  const updateState = useUpdateState();
  const updateIssue = useUpdateIssue();
  const dragId = useRef<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const dropOn = (g: IssueGroup) => {
    const id = dragId.current;
    dragId.current = null;
    setOverKey(null);
    if (!id) return;
    const issue = issues.find((i) => i.id === id);
    if (!issue) return;
    if (g.dropState !== undefined) {
      if (issue.state !== g.dropState)
        updateState.mutate({ root, id, state: g.dropState, note: `moved to ${g.dropState} via board` });
    } else if (g.dropAssignee !== undefined) {
      if ((issue.assignee?.id ?? null) !== (g.dropAssignee ?? null))
        updateIssue.mutate({
          root,
          id,
          patch: { assignee: g.dropAssignee ? { type: "member", id: g.dropAssignee } : null },
        });
    } else if (g.dropParent !== undefined) {
      if ((issue.parent ?? null) !== g.dropParent) updateIssue.mutate({ root, id, patch: { parent: g.dropParent } });
    }
  };

  return (
    <div className="flex gap-2 min-w-fit h-full">
      {groups.map((g) => {
        const droppable = selected && canDrop(g);
        return (
          <div
            key={g.key}
            onDragOver={droppable ? (e) => { e.preventDefault(); setOverKey(g.key); } : undefined}
            onDragLeave={droppable ? () => setOverKey((k) => (k === g.key ? null : k)) : undefined}
            onDrop={droppable ? (e) => { e.preventDefault(); dropOn(g); } : undefined}
            className={`flex flex-col w-[220px] shrink-0 rounded-lg transition-colors ${
              overKey === g.key ? "bg-[var(--color-bg4)] ring-1 ring-[var(--color-brand)]" : ""
            }`}
          >
            <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10.5px] font-mono text-[var(--color-fg2)]">
              {g.header}
              <span className="ml-auto text-[var(--color-fg3)] tabular-nums">{g.items.length}</span>
            </div>
            <div className="flex flex-col gap-2 px-0.5 pb-2 overflow-y-auto">
              {g.items.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  root={root}
                  onWork={() => onWork(issue)}
                  draggable={selected}
                  onDragStart={(e) => {
                    dragId.current = issue.id;
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragId.current = null;
                    setOverKey(null);
                  }}
                />
              ))}
              {g.items.length === 0 && (
                <div className="text-[10.5px] text-[var(--color-fg3)] px-1.5 py-2">—</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
