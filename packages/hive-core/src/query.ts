import type { Issue, IssueSummary, IssueState, Assignee } from "./types.js";

export interface QueryFilter {
  state?: IssueState | IssueState[];
  parent?: string | null;
  assignee?: string; // matches assignee.id
  label?: string;
  hasGithub?: boolean;
}

export function filterIssues<T extends IssueSummary | Issue>(
  issues: T[],
  q: QueryFilter
): T[] {
  return issues.filter((i) => {
    if (q.state) {
      const states = Array.isArray(q.state) ? q.state : [q.state];
      if (!states.includes(i.state)) return false;
    }
    if (q.parent !== undefined && i.parent !== q.parent) return false;
    if (q.assignee !== undefined) {
      const a = i.assignee as Assignee | null;
      if (!a || a.id !== q.assignee) return false;
    }
    if (q.label !== undefined && !i.labels.includes(q.label)) return false;
    if (q.hasGithub === true && i.github == null) return false;
    if (q.hasGithub === false && i.github != null) return false;
    return true;
  });
}

/** Group children of a given parent (null = top-level). */
export function childrenOf<T extends IssueSummary | Issue>(
  issues: T[],
  parentId: string | null
): T[] {
  return issues.filter((i) => i.parent === parentId);
}

/** Walk the parent chain. Returns chain root → ancestors → self. */
export function ancestorsOf<T extends IssueSummary | Issue>(
  issues: T[],
  id: string
): T[] {
  const map = new Map(issues.map((i) => [i.id, i]));
  const chain: T[] = [];
  let cursor: T | undefined = map.get(id);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parent ? map.get(cursor.parent) : undefined;
  }
  return chain;
}

/** Detect whether `descendant` is a descendant of `ancestor` (or equal). */
export function isDescendantOf(
  issues: IssueSummary[],
  descendant: string,
  ancestor: string
): boolean {
  if (descendant === ancestor) return true;
  const map = new Map(issues.map((i) => [i.id, i] as const));
  let cursor = map.get(descendant);
  while (cursor) {
    if (cursor.id === ancestor) return true;
    cursor = cursor.parent ? map.get(cursor.parent) : undefined;
  }
  return false;
}
