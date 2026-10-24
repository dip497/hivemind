// The start-work guard (design jira-sync §10): every way of starting work on an issue asks this
// first — the Issues tool's "Work on this", a drag into an in-progress status, `hive ctl set-state`
// / `hive update --status`, `hive ctl spawn --issue`, `hive ctl workflow` over issues. It lives in
// core so the CLI can ask it with no host running. A tracker adds its own checks, a live refresh
// and "Assign to me" through a provider, matched on the issue's `external.source`.
import type { Issue } from "./types.js";

/** The checks of design §10, by name: what `--ack` takes. */
export type StartCheck =
  | "unassigned" // #1 the tracker's assignee is nobody
  | "assigned-other" // #2 the tracker's assignee is someone else
  | "in-progress-other" // #3 already in an in_progress-category status, by someone else
  | "closed" // #4 done or cancelled category
  | "not-in-sprint" // #5 backlog or a future sprint
  | "blocked" // #6 blocked by an unresolved issue
  | "flagged" // #7 flagged / impediment
  | "no-permission" // #8 may not transition, or may not be assigned
  | "parent-closed" // #9 a sub-task whose parent is done, or an epic closed
  | "claimed-elsewhere" // #10 another hive install is on it
  | "agent-active"; // #11 an agent tile here already works this issue

/** What the person (or an agent, through the CLI flags) can do about a finding. */
export type StartAction = "assign-me" | "start" | "start-local" | "reopen" | "open-blocker" | "focus-tile" | "cancel";

export interface StartFinding {
  check: StartCheck;
  /** `info` never stops a start; `warn` needs an ack (or `--force`); `block` can't be forced. */
  severity: "info" | "warn" | "block";
  /** One sentence for the person, naming who or what (the assignee, the blocker's key, the tile). */
  message: string;
  actions: StartAction[];
  /** The issue or tile an action points at: the blocker for `open-blocker`, the tile for `focus-tile`. */
  target?: string;
}

export interface StartContext {
  /** Who is starting: `ui` for the person, an agent's tile name, … (activity rows name it). */
  actor: string;
  /** Agent tiles working an issue here right now (`tile.issue`), for check #11. */
  activeTiles?: { tile: string; issue: string }[];
  now?: Date;
  /** Re-fetch the issue through its provider when it was synced longer ago than this (default 60 s). */
  staleAfterMs?: number;
}

export interface StartVerdict {
  /** The issue as checked: re-fetched by its provider when it was stale. */
  issue: Issue;
  findings: StartFinding[];
}

/** A tracker's part in the guard. Registered by whatever code knows the tracker (the Jira plugin's
 *  service, through the host); a source with no provider is checked from its mirrored fields alone. */
export interface StartWorkProvider {
  /** The `external.source` prefix it answers for, e.g. `jira:`. */
  source: string;
  /** The issue as the tracker has it now, written through ingest; called when the copy is stale. */
  refresh?(root: string, issue: Issue): Promise<Issue>;
  /** Checks only the tracker can make (permissions, another install's claim, …). */
  checks?(root: string, issue: Issue, ctx: StartContext): Promise<StartFinding[]>;
  /** "Assign to me": make the person whose credentials the sync uses the tracker's assignee. */
  assignMe?(root: string, issue: Issue): Promise<void>;
}

const providers: StartWorkProvider[] = [];

/** Register a tracker's provider; returns how to remove it. */
export function registerStartWorkProvider(p: StartWorkProvider): () => void {
  providers.push(p);
  return () => {
    const i = providers.indexOf(p);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** The provider for an issue's source, if one is registered. */
export function providerFor(issue: Issue): StartWorkProvider | undefined {
  const source = issue.external?.source;
  return source ? providers.find((p) => source.startsWith(p.source)) : undefined;
}

/** What is left once the caller acknowledged some checks (`--ack`) or all warnings (`--force`).
 *  `block` findings are never dropped; `info` never needs dropping. */
export function unacknowledged(findings: StartFinding[], ack: { checks?: StartCheck[]; force?: boolean }): StartFinding[] {
  return findings.filter((f) => f.severity === "block" || (f.severity === "warn" && !ack.force && !(ack.checks ?? []).includes(f.check)));
}

/** Check whether work on `id` may start (design §10). Implemented in P1 (HIVEMI-1.6). */
export async function checkStartWork(_root: string, _id: string, _ctx: StartContext): Promise<StartVerdict> {
  throw new Error("checkStartWork: not implemented yet (P1)");
}
