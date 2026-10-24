/**
 * What an external tracker says about a mirrored issue (`external`, design jira-sync §5.1, §7.1,
 * §13), read the same way for any tracker: the key, type, priority, estimate and sprint for its
 * card, whose it is there (the assignee filter: Me, Unassigned, Anyone or one person), whether it
 * left the sync's scope, and which fields the tracker owns. A summary carries `external` as core
 * wrote it; the view protocol leaves it untyped, so it is checked here before it is used.
 */
import type { IssueSummary } from "./data";

export interface TrackerUser { accountId?: string; name: string; me?: boolean }
export interface TrackerRef {
  provider: string;
  key: string;
  url?: string;
  type?: { id: string; name: string };
  assignee: TrackerUser | null;
  priority?: string;
  estimate?: number;
  sprint?: { id: number; name: string; state: string } | null;
  /** Hidden from the board unless it has local work, when it shows "not in scope". */
  archived: boolean;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const userOf = (v: unknown): TrackerUser | null => {
  const u = v as { accountId?: unknown; name?: unknown; me?: unknown } | null;
  return u && typeof u === "object" && text(u.name) ? { name: u.name as string, ...(text(u.accountId) ? { accountId: u.accountId as string } : {}), ...(u.me === true ? { me: true } : {}) } : null;
};

/** The tracker's view of an issue; null for an issue that lives only here. */
export function trackerOf(i: object): TrackerRef | null {
  const e = (i as { external?: Record<string, unknown> }).external;
  if (!e || typeof e !== "object" || !text(e.provider) || !text(e.key)) return null;
  const type = e.type as { id?: unknown; name?: unknown } | undefined;
  const sprint = e.sprint as { id?: unknown; name?: unknown; state?: unknown } | null | undefined;
  return {
    provider: e.provider as string,
    key: e.key as string,
    ...(text(e.url) && /^https?:\/\//i.test(e.url as string) ? { url: e.url as string } : {}),
    ...(type && text(type.name) ? { type: { id: String(type.id ?? ""), name: type.name as string } } : {}),
    assignee: userOf(e.assignee),
    ...(text(e.priority) ? { priority: e.priority as string } : {}),
    ...(typeof e.estimate === "number" && Number.isFinite(e.estimate) ? { estimate: e.estimate } : {}),
    ...(sprint && typeof sprint.id === "number" && text(sprint.name) ? { sprint: { id: sprint.id, name: sprint.name as string, state: String(sprint.state ?? "") } } : {}),
    archived: !!(e.archived && typeof e.archived === "object"),
  };
}

/** The tracker's name as the person reads it: `jira` → Jira. */
export const trackerName = (provider: string): string => provider.charAt(0).toUpperCase() + provider.slice(1);

// ── the assignee filter (design §7.1) ───────────────────────────

/** Whose mirrored issues the board shows: mine, nobody's, anyone's, or one person's
 *  (`person:<accountId or name>`). An issue that lives only here is always shown. */
export type TrackerAssignee = "me" | "unassigned" | "anyone" | `person:${string}`;
export const DEFAULT_TRACKER_ASSIGNEE: TrackerAssignee = "me";

const personKey = (u: TrackerUser): string => u.accountId ?? u.name;

export function isTrackerAssignee(v: unknown): v is TrackerAssignee {
  return v === "me" || v === "unassigned" || v === "anyone" || (typeof v === "string" && v.startsWith("person:") && v.length > 7);
}

export function matchesTrackerAssignee(i: object, f: TrackerAssignee): boolean {
  const t = trackerOf(i);
  if (!t || f === "anyone") return true;
  if (f === "me") return !!t.assignee?.me;
  if (f === "unassigned") return !t.assignee;
  return !!t.assignee && personKey(t.assignee) === f.slice("person:".length);
}

/** Whether any issue here is mirrored: only then does the board offer the filter. */
export const hasMirrored = (issues: readonly object[]): boolean => issues.some((i) => trackerOf(i) !== null);

/** The people mirrored issues are assigned to, besides me, by name, for the person picker. */
export function trackerPeople(issues: readonly object[]): Array<{ key: TrackerAssignee; name: string }> {
  const seen = new Map<string, string>();
  for (const i of issues) {
    const a = trackerOf(i)?.assignee;
    if (a && !a.me && !seen.has(personKey(a))) seen.set(personKey(a), a.name);
  }
  return [...seen].map(([k, name]) => ({ key: `person:${k}` as TrackerAssignee, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** What the filter says, for its button. */
export function trackerAssigneeLabel(f: TrackerAssignee, issues: readonly object[]): string {
  if (f === "me") return "Me";
  if (f === "unassigned") return "Unassigned";
  if (f === "anyone") return "Anyone";
  return trackerPeople(issues).find((p) => p.key === f)?.name ?? f.slice("person:".length);
}

// ── the card and the panel (design §13) ─────────────────────────

/** What a mirrored issue's card shows besides hive's own: the tracker's type, priority and estimate,
 *  its sprint when it is not the active one, whose it is when it is not mine, and "not in scope". */
export interface CardFacts {
  type?: string;
  priority?: string;
  estimate?: string;
  sprint?: string;
  /** Someone else's: their name. Nobody's: "unassigned". Mine: absent. */
  owner?: { name: string } | "unassigned";
  notInScope: boolean;
}

export function cardFacts(i: IssueSummary): CardFacts | null {
  const t = trackerOf(i);
  if (!t) return null;
  return {
    ...(t.type ? { type: t.type.name } : {}),
    ...(t.priority ? { priority: t.priority } : {}),
    ...(t.estimate !== undefined ? { estimate: `${t.estimate}` } : {}),
    ...(t.sprint && t.sprint.state !== "active" ? { sprint: t.sprint.name } : {}),
    ...(!t.assignee ? { owner: "unassigned" as const } : !t.assignee.me ? { owner: { name: t.assignee.name } } : {}),
    notInScope: t.archived,
  };
}

/** Fields of a mirrored issue its tracker owns (design §8.1): shown, not edited here. */
export const TRACKER_OWNED = ["title", "description", "labels", "parent"] as const;
export type TrackerOwned = (typeof TRACKER_OWNED)[number];
export const trackerOwns = (i: object, field: TrackerOwned): boolean => trackerOf(i) !== null && (TRACKER_OWNED as readonly string[]).includes(field);
