// The start-work guard (design jira-sync §10): every way of starting work on an issue asks this
// first — the Issues tool's "Work on this", a drag into an in-progress status, `hive ctl set-state`
// / `hive update --status`, `hive ctl spawn --issue`, `hive ctl workflow` over issues. It lives in
// core so the CLI can ask it with no host running. A tracker adds its own checks, a live refresh
// and "Assign to me" through a provider, matched on the issue's `external.source`.
import type { Issue, IssueState } from "./types.js";
import { readIssue } from "./storage.js";
import { rootForId } from "./json.js";
import { categoryOf, defaultStatus, issueTypeOf, loadWorkflow, statusOf, transitionTargets } from "./workflow.js";

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

/** Every check's name, in the order of design §10's table: what `--ack` accepts. */
export const START_CHECKS: readonly StartCheck[] = [
  "unassigned", "assigned-other", "in-progress-other", "closed", "not-in-sprint", "blocked", "flagged",
  "no-permission", "parent-closed", "claimed-elsewhere", "agent-active",
];

const DEFAULT_STALE_MS = 60_000;

/** A link to an issue that blocks this one, as a tracker hands it over before both ends are
 *  mirrored (`external.links`, design §6.4): hive's link type, or Jira's own `Blocks` + `inward`. */
interface ExternalLink { id?: unknown; key?: unknown; type?: unknown; direction?: unknown; category?: unknown }

const closedCategory = (s: unknown): boolean => s === "done" || s === "cancelled";

/** The issues `issue` says block it: hive's `links`, then the tracker's `external.links`. A tracker
 *  link may say its other end's category, which is used when that end isn't mirrored here. */
function blockersOf(issue: Issue): { id: string; category?: string }[] {
  const out = new Map<string, { id: string; category?: string }>();
  for (const l of issue.links ?? []) if (l.type === "blocked-by") out.set(l.id, { id: l.id });
  const ext = (issue.external as { links?: unknown } | undefined)?.links;
  for (const raw of Array.isArray(ext) ? (ext as ExternalLink[]) : []) {
    const id = typeof raw?.key === "string" ? raw.key : typeof raw?.id === "string" ? raw.id : undefined;
    if (!id || out.has(id)) continue;
    const blockedBy = raw.type === "blocked-by" || (typeof raw.type === "string" && raw.type.toLowerCase() === "blocks" && raw.direction === "inward");
    if (blockedBy) out.set(id, { id, ...(typeof raw.category === "string" ? { category: raw.category } : {}) });
  }
  return [...out.values()];
}

/** The category of another issue, wherever it is kept (here, or a workspace the registry knows);
 *  undefined when it can't be read. */
async function categoryElsewhere(root: string, id: string): Promise<IssueState | undefined> {
  try {
    return (await readIssue(await rootForId(root, id), id)).state;
  } catch {
    try {
      return (await readIssue(root, id)).state;
    } catch {
      return undefined;
    }
  }
}

/** The tracker permissions the sync read for this issue, when it read them: a list of the ones
 *  held, or a map of each to whether it is. */
function permissionsOf(issue: Issue): ((p: string) => boolean) | undefined {
  const p = (issue.external as { permissions?: unknown } | undefined)?.permissions;
  if (Array.isArray(p)) return (name) => p.includes(name);
  if (p && typeof p === "object") return (name) => (p as Record<string, unknown>)[name] === true;
  return undefined;
}

/** The checks design §10 makes from the issue as it is kept: a mirrored issue's tracker fields, its
 *  links, its parent and the agents working it here. A local issue gets #4, #6, #9 and #11. */
async function fieldChecks(root: string, issue: Issue, ctx: StartContext, provider: StartWorkProvider | undefined): Promise<StartFinding[]> {
  const out: StartFinding[] = [];
  const ext = issue.external;
  const mirrored = !!ext;
  const can = permissionsOf(issue);
  // "Assign to me" needs a tracker that can, and (when the sync says) the right to assign.
  const assignable = !!provider?.assignMe && (!can || can("ASSIGN_ISSUES"));
  const assign = (actions: StartAction[]): StartAction[] => (assignable ? actions : actions.filter((a) => a !== "assign-me"));

  if (mirrored && ext.assignee === null) {
    out.push({ check: "unassigned", severity: "warn", message: `${issue.id} is assigned to nobody in ${ext.provider}`, actions: assign(["assign-me", "start", "cancel"]) });
  } else if (mirrored && ext.assignee && ext.assignee.me !== true) {
    const who = ext.assignee.name;
    out.push(
      issue.state === "in_progress"
        ? { check: "in-progress-other", severity: "warn", message: `${who} already has ${issue.id} in progress`, actions: assign(["start", "assign-me", "cancel"]) }
        : { check: "assigned-other", severity: "warn", message: `${issue.id} is assigned to ${who} in ${ext.provider}`, actions: assign(["start", "assign-me", "cancel"]) },
    );
  }

  if (closedCategory(issue.state)) {
    // Reopening needs a way out of the status it is in, when the workflow lists the type's transitions.
    let reopen = true;
    if (mirrored) {
      const wf = loadWorkflow(root);
      const targets = transitionTargets(wf, issueTypeOf(wf, issue), statusOf(wf, issue));
      if (targets) reopen = targets.some((t) => !closedCategory(categoryOf(wf, t)));
    }
    out.push({ check: "closed", severity: "warn", message: `${issue.id} is already ${issue.state === "done" ? "done" : "cancelled"}`, actions: reopen ? ["reopen", "cancel"] : ["cancel"] });
  }

  if (mirrored && ext.sprint !== undefined && ext.sprint?.state !== "active") {
    out.push({ check: "not-in-sprint", severity: "info", message: ext.sprint ? `${issue.id} is in ${ext.sprint.name}, which is not the active sprint` : `${issue.id} is in the backlog, not in a sprint`, actions: ["start", "cancel"] });
  }

  for (const b of blockersOf(issue)) {
    const category = (await categoryElsewhere(root, b.id)) ?? b.category;
    if (closedCategory(category)) continue;
    out.push({ check: "blocked", severity: "warn", message: category ? `${issue.id} is blocked by ${b.id}, which is not resolved` : `${issue.id} is blocked by ${b.id}, which isn't kept here, so whether it is resolved is unknown`, actions: ["start", "open-blocker", "cancel"], target: b.id });
  }

  if (mirrored && issue.labels.some((l) => l.toLowerCase() === "flagged")) {
    out.push({ check: "flagged", severity: "warn", message: `${issue.id} is flagged as an impediment`, actions: ["start", "cancel"] });
  }

  if (mirrored && can) {
    const missing = ["TRANSITION_ISSUES", "ASSIGNABLE_USER"].filter((p) => !can(p));
    if (missing.length) {
      out.push({ check: "no-permission", severity: "info", message: `you may not ${missing.map((p) => (p === "TRANSITION_ISSUES" ? `move ${issue.id} in ${ext.provider}` : `be assigned ${issue.id}`)).join(" or ")}`, actions: ["start-local", "cancel"] });
    }
  }

  const parent = issue.parent ?? ext?.parentKey;
  if (parent) {
    const category = await categoryElsewhere(root, parent);
    if (closedCategory(category)) {
      out.push({ check: "parent-closed", severity: "info", message: `${issue.id}'s parent ${parent} is already ${category === "done" ? "done" : "cancelled"}`, actions: ["start", "cancel"], target: parent });
    }
  }

  const claim = (ext as { claimedBy?: unknown } | undefined)?.claimedBy as { by?: unknown; branch?: unknown; me?: unknown } | undefined;
  if (mirrored && claim && typeof claim === "object" && claim.me !== true && !(issue.branch && claim.branch === issue.branch)) {
    const by = typeof claim.by === "string" ? claim.by : "another install";
    out.push({ check: "claimed-elsewhere", severity: "warn", message: `${by} is already working ${issue.id}${typeof claim.branch === "string" ? ` on ${claim.branch}` : ""}`, actions: ["start", "cancel"] });
  }

  const active = (ctx.activeTiles ?? []).find((t) => t.issue === issue.id || (issue.aliases ?? []).includes(t.issue));
  if (active) {
    out.push({ check: "agent-active", severity: "block", message: `an agent here is already working ${issue.id} (tile ${active.tile})`, actions: ["focus-tile", "cancel"], target: active.tile });
  }
  return out;
}

/** A provider's findings, kept only when they name a check and a severity it may give. */
function sane(f: unknown): f is StartFinding {
  const x = f as StartFinding | null;
  return !!x && START_CHECKS.includes(x.check) && ["info", "warn", "block"].includes(x.severity) && typeof x.message === "string" && Array.isArray(x.actions);
}

/**
 * Check whether work on `id` may start (design §10): every finding, each with its severity and
 * what can be done about it. A mirrored issue synced longer ago than `staleAfterMs` is re-fetched
 * through its tracker's provider first. Nothing here touches the network but a provider.
 */
export async function checkStartWork(root: string, id: string, ctx: StartContext): Promise<StartVerdict> {
  let issue = await readIssue(root, id);
  const provider = providerFor(issue);
  const now = (ctx.now ?? new Date()).getTime();
  const synced = issue.external?.syncedAt ? Date.parse(issue.external.syncedAt) : NaN;
  if (provider?.refresh && issue.external && !(now - synced <= (ctx.staleAfterMs ?? DEFAULT_STALE_MS))) {
    issue = await provider.refresh(root, issue);
  }
  const findings = await fieldChecks(root, issue, ctx, provider);
  if (provider?.checks) {
    const own = new Set(findings.map((f) => f.check));
    for (const f of await provider.checks(root, issue, ctx)) if (sane(f) && !own.has(f.check)) findings.push(f);
  }
  findings.sort((a, b) => START_CHECKS.indexOf(a.check) - START_CHECKS.indexOf(b.check));
  return { issue, findings };
}

/** The status starting work moves an issue to: its type's first `in_progress` status (design §11.1). */
export function startStatus(root: string, issue: Pick<Issue, "external">): string {
  const wf = loadWorkflow(root);
  return (defaultStatus(wf, "in_progress", issueTypeOf(wf, issue)) ?? defaultStatus(wf, "in_progress"))?.id ?? "in_progress";
}

/** Why a start was refused for what is left after the acks, said for an agent: the message, the
 *  flags that go on (`fix`), and each finding (`warnings`). */
export function needsConfirm(id: string, left: StartFinding[]): { message: string; fix: string; warnings: StartFinding[] } {
  const blocked = left.filter((f) => f.severity === "block");
  const warn = left.filter((f) => f.severity === "warn");
  const message = blocked.length
    ? `can't start ${id}: ${blocked.map((f) => f.message).join("; ")}`
    : `starting ${id} needs the person to confirm: ${warn.map((f) => f.message).join("; ")}`;
  const fix = blocked.length
    ? "this can't be forced: work in the tile that has it (`hive ctl focus <tile>`), or close it first"
    : `ask the person; then re-run with ${[...new Set(warn.map((f) => f.check))].map((c) => `--ack ${c}`).join(" ")}${warn.some((f) => f.actions.includes("assign-me")) ? " or --assign-me" : ""} (never --force on your own)`;
  return { message, fix, warnings: left };
}
