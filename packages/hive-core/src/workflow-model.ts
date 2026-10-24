// The workflow model (design jira-sync §4), free of node so a renderer and a view can use the same
// rules as core: the schema, the built-in workflow, validation and the status ↔ category rules.
// Reading `.hivemind/workflow.yaml` is `workflow.ts`'s.
import { z } from "zod";
import { IssueStateZ, type IssueState } from "./types.js";

export const WorkflowStatusZ = z
  .object({
    /** Source-scoped and stable: `jira:10001`, `hive:pr-created`, or a built-in category id. */
    id: z.string().min(1),
    name: z.string().min(1),
    category: IssueStateZ,
    color: z.string().optional(),
    /** Who owns it: `hive` (the person) or a tracker (`jira`) whose discovery writes it. */
    source: z.string().min(1).default("hive"),
    /** A hive-only status's Jira counterpart: a status id to follow, or `stay` (design §8.2). */
    jira: z.object({ follow: z.string().min(1) }).or(z.literal("stay")).optional(),
    /** No longer in the tracker but still used by an issue; kept so the issue stays readable. */
    retired: z.boolean().optional(),
  })
  .loose();
export type WorkflowStatus = z.infer<typeof WorkflowStatusZ>;

export const WorkflowTransitionZ = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    /** Status ids it leaves from; `"*"` is a global transition. */
    from: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
    to: z.string().min(1),
    screen: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  })
  .loose();

export const WorkflowZ = z
  .object({
    version: z.literal(1),
    statuses: z.array(WorkflowStatusZ).min(1),
    /** Per issue type (`jira:10004`): which statuses it may have, its first status, its transitions. */
    issueTypes: z
      .record(
        z.string(),
        z
          .object({
            statuses: z.array(z.string().min(1)).min(1),
            initial: z.string().min(1).optional(),
            transitions: z.array(WorkflowTransitionZ).default([]),
          })
          .loose(),
      )
      .default({}),
    board: z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        type: z.string().optional(),
        columns: z.array(z.object({ name: z.string().min(1), statuses: z.array(z.string().min(1)) }).loose()).min(1),
      })
      .loose()
      .optional(),
    /** hive's rules for its own statuses: a status id, or `category:<state>` (design §4.2). */
    local: z
      .object({ onPrOpened: z.string().optional(), onPrMerged: z.string().optional(), onPrClosed: z.string().optional() })
      .loose()
      .default({}),
  })
  .loose();
export type Workflow = z.infer<typeof WorkflowZ>;

const BUILTIN_NAMES: Record<IssueState, string> = {
  backlog: "Backlog",
  todo: "Todo",
  // As the board has always labelled them, so a workspace without a workflow looks as it did.
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  cancelled: "Cancelled",
};

/** The workflow of a workspace with no `workflow.yaml`: one status per category, id = category. */
export const BUILTIN_WORKFLOW: Workflow = WorkflowZ.parse({
  version: 1,
  statuses: IssueStateZ.options.map((s) => ({ id: s, name: BUILTIN_NAMES[s], category: s })),
});

/** What is wrong with a workflow beyond its shape (design §4.2 "Validation"). Empty = valid. */
export function workflowProblems(wf: Workflow): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const s of wf.statuses) {
    if (ids.has(s.id)) out.push(`status id ${s.id} is used twice`);
    ids.add(s.id);
  }
  for (const c of IssueStateZ.options) {
    if (!wf.statuses.some((s) => s.category === c && !s.retired)) out.push(`category ${c} has no status`);
  }
  const known = (id: string, where: string) => {
    if (!ids.has(id)) out.push(`${where} names unknown status ${id}`);
  };
  for (const s of wf.statuses) if (s.jira && s.jira !== "stay") known(s.jira.follow, `status ${s.id} follow`);
  for (const [type, t] of Object.entries(wf.issueTypes)) {
    for (const s of t.statuses) known(s, `issue type ${type}`);
    if (t.initial) known(t.initial, `issue type ${type} initial`);
    for (const tr of t.transitions) {
      known(tr.to, `issue type ${type} transition ${tr.id}`);
      if (tr.from !== "*") for (const f of tr.from) known(f, `issue type ${type} transition ${tr.id}`);
    }
  }
  for (const col of wf.board?.columns ?? []) for (const s of col.statuses) known(s, `board column ${col.name}`);
  for (const [rule, target] of Object.entries(wf.local)) {
    if (typeof target !== "string") continue;
    if (target.startsWith("category:")) {
      if (!IssueStateZ.safeParse(target.slice("category:".length)).success) out.push(`local.${rule} names unknown ${target}`);
    } else known(target, `local.${rule}`);
  }
  return out;
}

export function findStatus<M extends StatusModel>(wf: M, idOrName: string): M["statuses"][number] | undefined {
  const lower = idOrName.toLowerCase();
  return wf.statuses.find((s) => s.id === idOrName) ?? wf.statuses.find((s) => s.name.toLowerCase() === lower);
}

/** The category (`state`) of a status id; undefined when the workflow doesn't know it. */
export function categoryOf(wf: StatusModel, statusId: string): IssueState | undefined {
  return wf.statuses.find((s) => s.id === statusId)?.category;
}

/**
 * The status an old-style `state` write lands on: the first non-retired status of that category,
 * in workflow order, limited to the issue type's statuses when it has its own list.
 */
export function defaultStatus<M extends StatusModel>(wf: M, category: IssueState, issueType?: string): M["statuses"][number] | undefined {
  const allowed = issueType ? wf.issueTypes[issueType]?.statuses : undefined;
  return wf.statuses.find((s) => s.category === category && !s.retired && (!allowed || allowed.includes(s.id)));
}

/** The categories in the order every surface lists them. */
export const CATEGORIES: readonly IssueState[] = IssueStateZ.options;

/** What the status rules read: a `Workflow`, or the `WorkflowView` a view or the CLI is sent. */
export interface StatusModel {
  statuses: readonly { id: string; name: string; category: IssueState; retired?: boolean }[];
  issueTypes: Record<string, { statuses: readonly string[] }>;
  /** A `WorkflowView`'s: false when the workspace has no workflow of its own. */
  custom?: unknown;
}

/** True when the workspace has no `workflow.yaml`: statuses are the categories, and no issue file
 *  carries a `status`. */
export const isBuiltinWorkflow = (wf: StatusModel): boolean => wf === BUILTIN_WORKFLOW || wf.custom === false;

/**
 * The issue type an issue's workflow is keyed by in `issueTypes`: its tracker type, prefixed with
 * the provider (`jira:10004`), when the workflow has a list for it. Undefined for a local issue.
 */
export function issueTypeOf(wf: StatusModel, issue: { external?: { provider: string; type?: { id: string } } }): string | undefined {
  const t = issue.external?.type?.id;
  if (!t) return undefined;
  const key = `${issue.external!.provider}:${t}`;
  if (wf.issueTypes[key]) return key;
  // Several linked projects key by `<projectId>/<type>` (design §4.2): the issue's own project is
  // not on it yet, so take the one key that ends in its type, if there is exactly one.
  const keys = Object.keys(wf.issueTypes).filter((k) => k.endsWith(`/${key}`));
  return keys.length === 1 ? keys[0] : undefined;
}

/** The status an issue is in: its own, else (an issue written before the workflow) the default of
 *  its category. With no workflow file it is always the state. */
export function statusOf(wf: StatusModel, issue: { state: IssueState; status?: string; external?: { provider: string; type?: { id: string } } }): string {
  if (isBuiltinWorkflow(wf)) return issue.state;
  if (issue.status && categoryOf(wf, issue.status) === issue.state) return issue.status;
  if (issue.status && !wf.statuses.some((s) => s.id === issue.status)) return issue.status;
  return defaultStatus(wf, issue.state, issueTypeOf(wf, issue))?.id ?? defaultStatus(wf, issue.state)?.id ?? issue.state;
}

/** The status `idOrName` names: its id, else its name, either case-insensitive. */
export function resolveStatus<M extends StatusModel>(wf: M, idOrName: string): M["statuses"][number] | undefined {
  const lower = idOrName.trim().toLowerCase();
  return findStatus(wf, idOrName.trim()) ?? wf.statuses.find((s) => s.id.toLowerCase() === lower);
}

/** Every status a person may name, for a refusal: `Code Review (jira:10003), …`. */
export const statusChoices = (wf: StatusModel): string =>
  wf.statuses.filter((s) => !s.retired).map((s) => (s.id === s.name ? s.id : `${s.name} (${s.id})`)).join(", ");

/** A status as every surface lists it. `color` is absent when the surface's own category colour applies. */
export interface WorkflowStatusView {
  id: string;
  name: string;
  category: IssueState;
  color?: string;
  source: string;
  retired?: boolean;
}

/** The workflow as views, the CLI and services read it (`issue.workflow`): statuses in the order
 *  every surface lists them — category order, then the workflow's own — and the board and the
 *  per-type transitions when the workflow has them. */
export interface WorkflowView {
  /** False for a workspace with no `workflow.yaml` (its statuses are the categories). */
  custom: boolean;
  statuses: WorkflowStatusView[];
  board?: { columns: { name: string; statuses: string[] }[] };
  issueTypes: Record<string, { statuses: string[]; initial?: string; transitions: { id: string; name?: string; from: "*" | string[]; to: string }[] }>;
}

const views = new WeakMap<Workflow, WorkflowView>();

export function workflowView(wf: Workflow): WorkflowView {
  const hit = views.get(wf);
  if (hit) return hit;
  const rank = (c: IssueState) => CATEGORIES.indexOf(c);
  const statuses = wf.statuses
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.category) - rank(b.s.category) || a.i - b.i)
    .map(({ s }) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      source: s.source,
      ...(s.color ? { color: s.color } : {}),
      ...(s.retired ? { retired: true } : {}),
    }));
  const view: WorkflowView = {
    custom: !isBuiltinWorkflow(wf),
    statuses,
    ...(wf.board ? { board: { columns: wf.board.columns.map((c) => ({ name: c.name, statuses: [...c.statuses] })) } } : {}),
    issueTypes: Object.fromEntries(
      Object.entries(wf.issueTypes).map(([k, t]) => [
        k,
        {
          statuses: [...t.statuses],
          ...(t.initial ? { initial: t.initial } : {}),
          transitions: t.transitions.map((tr) => ({ id: tr.id, ...(tr.name ? { name: tr.name } : {}), from: tr.from === "*" ? "*" : [...tr.from], to: tr.to })),
        },
      ]),
    ),
  };
  views.set(wf, view);
  return view;
}

/** One rule for core, the app and views: it lives with the view protocol's workflow shape. */
export { transitionTargets } from "@hivemind/view-sdk/protocol";
