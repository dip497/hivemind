import type { ReactNode } from "react";
import type { IssueState, IssueSummary } from "@hivemind/core/types";
import { STATE_ORDER, STATE_LABEL, StateIcon, Avatar, LabelChip } from "../components/StateMeta";

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
  /** Present only for state groups — enables drop-to-set-state. */
  dropState?: IssueState;
  /** Present for assignee/parent groups — enables drop-to-set that single-valued
   *  field. `null` means "clear it" (Unassigned / Top-level). Absent ⇒ no drop. */
  dropAssignee?: string | null;
  dropParent?: string | null;
}

/** Group + order issues for the board/list. State grouping uses the canonical
 *  STATE_ORDER (cancelled hidden unless asked); the others derive groups from the
 *  data. Single-valued group keys (state/assignee/parent) carry a `drop*` hint so
 *  BoardView can turn a drop into the right mutation. Label is multi-valued, so it
 *  has no drop target. */
export function groupIssues(issues: IssueSummary[], by: GroupBy, showCancelled: boolean): IssueGroup[] {
  if (by === "state") {
    return STATE_ORDER.filter((s) => showCancelled || s !== "cancelled").map((s) => ({
      key: s,
      label: STATE_LABEL[s],
      header: (
        <>
          <StateIcon state={s} size={12} />
          <span>{STATE_LABEL[s]}</span>
        </>
      ),
      items: issues.filter((i) => i.state === s),
      dropState: s,
    }));
  }

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
    header: p ? <span className="font-mono text-[10.5px]">{p}</span> : <span className="text-[var(--color-fg3)]">Top-level</span>,
    items: issues.filter((i) => (i.parent ?? "") === p),
    dropParent: p || null,
  }));
}
