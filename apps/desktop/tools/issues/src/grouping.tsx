import type { ReactNode } from "react";
import { ISSUE_STATES } from "@hivemind/view-sdk/protocol";
import { statusById, statusOfIssue, type IssueSummary, type Workflow, type WorkflowStatus } from "./data";
import { StatusIcon, Avatar, HiveOnlyMark, LabelChip } from "./StateMeta";

/** What the board columns / list sections are grouped by. */
export type GroupBy = "state" | "assignee" | "label" | "parent";

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  state: "State",
  assignee: "Assignee",
  label: "Label",
  parent: "Parent",
};
export const GROUP_BY_ORDER: GroupBy[] = ["state", "assignee", "label", "parent"];

export interface IssueGroup {
  /** Stable key (state value for state-grouping). */
  key: string;
  label: string;
  /** Rendered header content (icon + label). */
  header: ReactNode;
  items: IssueSummary[];
  /** Present only for status groups: the statuses a card dropped here may take (several in a
   *  board column that groups them: the drop asks which). */
  dropStatuses?: WorkflowStatus[];
  /** Present for assignee/parent groups — enables drop-to-set that single-valued
   *  field. `null` means "clear it" (Unassigned / Top-level). Absent ⇒ no drop. */
  dropAssignee?: string | null;
  dropParent?: string | null;
}

const rank = (s: WorkflowStatus) => ISSUE_STATES.indexOf(s.category);

/** The status columns: the workflow's board columns when it has them, with every status no column
 *  holds placed by its state (the board's own order kept); else one per status, in the workflow's order (state order, then the
 *  file's). A retired status gets a column only while an issue sits in it; cancelled ones only when
 *  asked for, and a cancelled issue in a mixed column likewise. */
export function statusColumns(issues: IssueSummary[], wf: Workflow, showCancelled: boolean): IssueGroup[] {
  const used = new Set(issues.map(statusOfIssue));
  const live = wf.statuses.filter((s) => !s.retired || used.has(s.id));
  // A status no workflow names (written before a status was removed) still gets a column.
  for (const id of used) {
    if (!wf.statuses.some((s) => s.id === id)) live.push(statusById(wf, id, issues.find((i) => statusOfIssue(i) === id)!.state));
  }
  const byId = new Map(live.map((s) => [s.id, s]));
  const onBoard = new Set(wf.board?.columns.flatMap((c) => c.statuses) ?? []);
  // The board's columns in the board's order, whatever their states: a Jira board may put an
  // in-progress "Ready for release" after "Review".
  const slots: { name: string; statuses: WorkflowStatus[]; at: number }[] = (wf.board?.columns ?? []).map((c) => {
    const statuses = c.statuses.map((id) => byId.get(id)).filter((s): s is WorkflowStatus => !!s);
    return { name: c.name, statuses, at: Math.min(...statuses.map(rank), 99) };
  });
  // A status no column holds goes before the first column of a later state, in the workflow's order.
  for (const s of live.filter((x) => !onBoard.has(x.id))) {
    const at = slots.findIndex((slot) => slot.at > rank(s));
    slots.splice(at < 0 ? slots.length : at, 0, { name: s.name, statuses: [s], at: rank(s) });
  }
  return slots
    .map((slot) => ({ ...slot, statuses: slot.statuses.filter((s) => showCancelled || s.category !== "cancelled") }))
    .filter((slot) => slot.statuses.length > 0)
    .map(({ name, statuses }) => {
      const ids = new Set(statuses.map((s) => s.id));
      const first = statuses[0]!;
      const hiveOnly = wf.custom && statuses.every((s) => s.source === "hive");
      return {
        // One status: its id (with no workflow, the state: as the board has always keyed it).
        key: statuses.length === 1 ? first.id : `column:${name}`,
        label: name,
        header: (
          <>
            <StatusIcon status={first} />
            <span>{name}</span>
            {hiveOnly && <HiveOnlyMark />}
          </>
        ),
        items: issues.filter((i) => ids.has(statusOfIssue(i))),
        dropStatuses: statuses,
      };
    });
}

/** Group + order issues for the board/list. Status grouping follows the workspace's workflow; the
 *  others derive groups from the data. Single-valued group keys (status/assignee/parent) carry a
 *  `drop*` hint so BoardView can turn a drop into the right mutation. Label is multi-valued, so it
 *  has no drop target. */
export function groupIssues(issues: IssueSummary[], by: GroupBy, showCancelled: boolean, wf: Workflow): IssueGroup[] {
  if (by === "state") return statusColumns(issues, wf, showCancelled);

  if (by === "assignee") {
    const ids = Array.from(new Set(issues.map((i) => i.assignee?.id ?? "")));
    ids.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))); // unassigned last
    return ids.map((id) => ({
      key: id || "__none",
      label: id ? `@${id}` : "Unassigned",
      header: id ? (
        <>
          <Avatar id={id} size={14} />
          <span>@{id}</span>
        </>
      ) : (
        <span className="text-[var(--color-fg3)]">Unassigned</span>
      ),
      items: issues.filter((i) => (i.assignee?.id ?? "") === id),
      dropAssignee: id || null,
    }));
  }

  if (by === "label") {
    const labels = Array.from(new Set(issues.flatMap((i) => i.labels))).sort();
    const groups: IssueGroup[] = labels.map((l) => ({
      key: `label:${l}`,
      label: l,
      header: <LabelChip label={l} />,
      items: issues.filter((i) => i.labels.includes(l)), // multi-membership, no drop
    }));
    const noLabel = issues.filter((i) => i.labels.length === 0);
    if (noLabel.length)
      groups.push({ key: "__nolabel", label: "No label", header: <span className="text-[var(--color-fg3)]">No label</span>, items: noLabel });
    return groups;
  }

  // parent
  const parents = Array.from(new Set(issues.map((i) => i.parent ?? "")));
  parents.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))); // top-level first
  return parents.map((p) => ({
    key: p || "__top",
    label: p || "Top-level",
    header: p ? <span className="font-mono text-count">{p}</span> : <span className="text-[var(--color-fg3)]">Top-level</span>,
    items: issues.filter((i) => (i.parent ?? "") === p),
    dropParent: p || null,
  }));
}
