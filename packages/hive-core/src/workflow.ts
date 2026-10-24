// A workspace's workflow (design jira-sync §4): the statuses an issue may have, each in one of the
// six fixed categories (`IssueState`). With no `.hivemind/workflow.yaml` the workspace has the six
// built-in statuses, one per category, whose ids equal the category — which is how every
// workspace worked before workflows, so nothing changes until a file appears. The model itself
// (schema, rules) is `workflow-model.ts`, which has no node imports.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { BUILTIN_WORKFLOW, WorkflowZ, workflowProblems, workflowView, type Workflow, type WorkflowView } from "./workflow-model.js";

export * from "./workflow-model.js";

export const WORKFLOW_FILE = "workflow.yaml";

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
  const { workflow, problems } = parseWorkflow(readFileSync(file, "utf8"));
  if (!workflow) throw new Error(`${file}: ${problems.join("; ")}`);
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, wf: workflow });
  return workflow;
}

/** A workflow file's text read as a workflow, or every way it is not one (its YAML, its shape, then
 *  `workflowProblems`). What `loadWorkflow` refuses, said without throwing, for `hive statuses validate`. */
export function parseWorkflow(text: string): { workflow?: Workflow; problems: string[] } {
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (e) {
    return { problems: [`not YAML: ${(e as Error).message.split("\n")[0]}`] };
  }
  const parsed = WorkflowZ.safeParse(data);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`) };
  const problems = workflowProblems(parsed.data);
  return problems.length ? { problems } : { workflow: parsed.data, problems: [] };
}

/** The one source of truth for the statuses of the workspace at `root`: their order, names and
 *  colours (design §4.3). Cached with the workflow, so a caller per event gets the same object. */
export const workflowStatuses = (root: string): WorkflowView => workflowView(loadWorkflow(root));

