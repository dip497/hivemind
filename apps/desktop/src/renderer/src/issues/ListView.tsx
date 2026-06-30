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
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] font-semibold text-[var(--color-fg2)] sticky top-0 bg-[var(--color-bg2)]/95 backdrop-blur-sm z-10 rounded-md">
            {g.header}
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono tabular-nums bg-[var(--color-bg4)] text-[var(--color-fg3)]">
              {g.items.length}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {g.items.map((issue) => (
              <IssueRow key={issue.id} issue={issue} root={root} onWork={() => onWork(issue)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
