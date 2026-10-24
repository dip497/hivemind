import { useEffect, useRef, useState } from "react";
import { MenuItem } from "@hivemind/app-ui";
import { issueTypeOf, moveTo, statusOfIssue, transitionTargets, useIssuesPlugin, write, type Issues, type IssueSummary, type WorkflowStatus } from "./data";
import { groupIssues, type GroupBy, type IssueGroup } from "./grouping";
import { IssueCard } from "./IssueCard";
import { HiveOnlyMark, StatusIcon } from "./StateMeta";

const canDrop = (g: IssueGroup): boolean =>
  g.dropStatuses !== undefined || g.dropAssignee !== undefined || g.dropParent !== undefined;

/** A card dropped on a column of several statuses: which one. The moves its tracker allows from
 *  where the issue is come first; the rest are offered greyed, as hive moves them locally. */
function StatusPicker({ issue, statuses, onPick, onCancel }: { issue: IssueSummary; statuses: WorkflowStatus[]; onPick: (s: WorkflowStatus) => void; onCancel: () => void }) {
  const { workflow } = useIssuesPlugin();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onCancel(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [onCancel]);
  const here = statusOfIssue(issue);
  const legal = transitionTargets(workflow, issueTypeOf(workflow, issue), here);
  const ordered = legal ? [...statuses.filter((s) => legal.includes(s.id)), ...statuses.filter((s) => !legal.includes(s.id))] : statuses;
  return (
    <div ref={ref} className="hm-popover absolute z-30 left-1.5 right-1.5 top-9" role="menu" aria-label={`Move ${issue.id} to`} data-status-picker>
      {ordered.map((s) => {
        const direct = !legal || legal.includes(s.id);
        return (
          <MenuItem
            key={s.id}
            size="sm"
            variant={direct ? "default" : "muted"}
            disabled={s.id === here}
            onClick={() => onPick(s)}
            title={direct ? undefined : "No direct transition from where it is"}
            data-status={s.id}
          >
            <StatusIcon status={s} size={11} />
            <span>{s.name}</span>
            {workflow.custom && s.source === "hive" && <HiveOnlyMark />}
            {!direct && <span className="ml-auto text-chip text-[var(--color-fg3)]">no direct transition</span>}
          </MenuItem>
        );
      })}
    </div>
  );
}

/** Kanban board grouped by `groupBy`. Cards drag between columns ONLY when the
 *  tile is focused (`selected`) — otherwise a drag would fight canvas pan. A drop
 *  applies the column's single-valued field (state / assignee / parent); label
 *  columns are multi-membership and have no drop target. */
export function BoardView({
  issues,
  groupBy,
  showCancelled,
  selected,
  onWork,
  answerFor,
}: {
  issues: IssueSummary[];
  groupBy: GroupBy;
  showCancelled: boolean;
  selected: boolean;
  onWork: (i: IssueSummary) => void;
  /** The start-work guard's say on moving an issue into progress (protocol 1.17). */
  answerFor?: Issues["answerFor"];
}) {
  const { hm, workflow } = useIssuesPlugin();
  const groups = groupIssues(issues, groupBy, showCancelled, workflow);
  const dragId = useRef<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [picking, setPicking] = useState<{ key: string; issue: IssueSummary } | null>(null);
  const move = async (issue: IssueSummary, to: WorkflowStatus) => {
    setPicking(null);
    if (statusOfIssue(issue) === to.id) return;
    // Into progress from elsewhere starts work: the guard asks first, and Assign to me goes first.
    if (to.category === "in_progress" && issue.state !== "in_progress" && answerFor) {
      const answer = await answerFor(issue, "move");
      if (answer === null) return;
      if (answer !== "legacy" && answer.assignMe && !(await write("Assigning the issue", hm.issues.start(issue.id, { ack: answer.ack as never, assignMe: true, agent: false })))) return;
    }
    void write("Moving the issue", moveTo(hm, workflow, issue.id, to, `moved to ${to.category} via board`));
  };

  const dropOn = (g: IssueGroup) => {
    const id = dragId.current;
    dragId.current = null;
    setOverKey(null);
    if (!id) return;
    const issue = issues.find((i) => i.id === id);
    if (!issue) return;
    if (g.dropStatuses !== undefined) {
      if (g.dropStatuses.length === 1) void move(issue, g.dropStatuses[0]!);
      else setPicking({ key: g.key, issue });
    } else if (g.dropAssignee !== undefined) {
      if ((issue.assignee?.id ?? null) !== (g.dropAssignee ?? null))
        void write("Assigning the issue", hm.issues.update(id, { assignee: g.dropAssignee ? { type: "member", id: g.dropAssignee } : null }));
    } else if (g.dropParent !== undefined) {
      if ((issue.parent ?? null) !== g.dropParent) void write("Moving the issue", hm.issues.update(id, { parent: g.dropParent }));
    }
  };

  return (
    <div className="flex gap-3 min-w-fit h-full">
      {groups.map((g) => {
        const droppable = selected && canDrop(g);
        return (
          <div
            key={g.key}
            onDragOver={droppable ? (e) => { e.preventDefault(); setOverKey(g.key); } : undefined}
            onDragLeave={droppable ? () => setOverKey((k) => (k === g.key ? null : k)) : undefined}
            onDrop={droppable ? (e) => { e.preventDefault(); dropOn(g); } : undefined}
            data-column={g.label}
            className={`relative flex flex-col w-[220px] shrink-0 rounded-lg hm-soft ${
              overKey === g.key
                ? "bg-[var(--color-bg4)] ring-1 ring-[var(--color-brand)]"
                : "bg-[color-mix(in_srgb,var(--color-bg3)_50%,transparent)]"
            }`}
          >
            <div className="flex items-center gap-1.5 px-2.5 py-2 text-count font-semibold text-[var(--color-fg2)]">
              {g.header}
              <span className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-chip font-mono tabular-nums bg-[var(--color-bg4)] text-[var(--color-fg3)]">
                {g.items.length}
              </span>
            </div>
            {picking?.key === g.key && g.dropStatuses && (
              <StatusPicker issue={picking.issue} statuses={g.dropStatuses} onPick={(s) => void move(picking.issue, s)} onCancel={() => setPicking(null)} />
            )}
            <div className="flex flex-col gap-2 px-1.5 pb-2 overflow-y-auto">
              {g.items.map((issue) => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
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
                <div className="text-count text-[var(--color-fg3)] px-2 py-3 rounded-md border border-dashed border-[var(--color-line2)] text-center">
                  {droppable ? "Drop here" : "No issues"}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
