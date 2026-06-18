import type { IssueSummary } from "@hivemind/core/types";
import { groupIssues, type GroupBy } from "./grouping";
import { IssueRow } from "./IssueCard";

/** Flat grouped list — a header row per group, then compact rows. Empty groups
 *  are hidden except when grouping by state (so the canonical columns still read
 *  as a tracker). */
export function ListView({
  issues,
  root,
  groupBy,
  showCancelled,
  onWork,
}: {
  issues: IssueSummary[];
  root: string;
  groupBy: GroupBy;
  showCancelled: boolean;
  onWork: (i: IssueSummary) => void;
}) {
  const groups = groupIssues(issues, groupBy, showCancelled).filter(
    (g) => g.items.length > 0 || groupBy === "state",
  );
  return (
    <div className="flex flex-col gap-3 pb-2">
      {groups.map((g) => (
        <div key={g.key}>
          <div className="flex items-center gap-1.5 px-1 py-1 text-[10.5px] font-mono text-[var(--color-fg2)] sticky top-0 bg-[var(--color-bg2)] z-10">
            {g.header}
            <span className="text-[var(--color-fg3)] tabular-nums">{g.items.length}</span>
          </div>
          <div className="flex flex-col">
            {g.items.map((issue) => (
              <IssueRow key={issue.id} issue={issue} root={root} onWork={() => onWork(issue)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
