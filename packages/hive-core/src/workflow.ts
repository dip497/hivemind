// A workspace's workflow (design jira-sync §4): the statuses an issue may have, each in one of the
// six fixed categories (`IssueState`). With no `.hivemind/workflow.yaml` the workspace has the six
// built-in statuses, one per category, whose ids equal the category — which is how every
// workspace worked before workflows, so nothing changes until a file appears.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { IssueStateZ, type IssueState } from "./types.js";

export const WORKFLOW_FILE = "workflow.yaml";

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
  in_progress: "In Progress",
  in_review: "In Review",
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

const cache = new Map<string, { mtimeMs: number; size: number; wf: Workflow }>();

/**
 * The workflow of the workspace at `root` (the `.hivemind` folder), or `BUILTIN_WORKFLOW` when it
 * has none. Re-read only when the file's mtime or size changes. An invalid file throws with what
 * is wrong — a workflow is never half-applied.
 */
export function loadWorkflow(root: string): Workflow {
  const file = path.join(root, WORKFLOW_FILE);
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      cache.delete(file);
      return BUILTIN_WORKFLOW;
    }
    throw e;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.wf;
  const parsed = WorkflowZ.safeParse(YAML.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const problems = workflowProblems(parsed.data);
  if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, wf: parsed.data });
  return parsed.data;
}

export function findStatus(wf: Workflow, idOrName: string): WorkflowStatus | undefined {
  const lower = idOrName.toLowerCase();
  return wf.statuses.find((s) => s.id === idOrName) ?? wf.statuses.find((s) => s.name.toLowerCase() === lower);
}

/** The category (`state`) of a status id; undefined when the workflow doesn't know it. */
export function categoryOf(wf: Workflow, statusId: string): IssueState | undefined {
  return wf.statuses.find((s) => s.id === statusId)?.category;
}

/**
 * The status an old-style `state` write lands on: the first non-retired status of that category,
 * in workflow order, limited to the issue type's statuses when it has its own list.
 */
export function defaultStatus(wf: Workflow, category: IssueState, issueType?: string): WorkflowStatus | undefined {
  const allowed = issueType ? wf.issueTypes[issueType]?.statuses : undefined;
  return wf.statuses.find((s) => s.category === category && !s.retired && (!allowed || allowed.includes(s.id)));
}
