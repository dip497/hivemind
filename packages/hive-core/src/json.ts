/**
 * JSON projections + cross-repo id resolution shared by every hive front end
 * (`hive ctl …`, the desktop). One place, so `hive ctl get-issue --json` and
 * the desktop render the same shape for the same issue.
 */
import path from "node:path";
import type { Issue } from "./types.js";
import { HiveError, findRoot, readConfig } from "./storage.js";
import { prefixOf, rootsForPrefix } from "./registry.js";

/** The stable machine-readable shape of an issue: frontmatter fields flattened,
 *  sections lifted to top-level keys. */
export function issueToJson(i: Issue) {
  return {
    id: i.id,
    title: i.title,
    state: i.state,
    parent: i.parent,
    labels: i.labels,
    assignee: i.assignee,
    github: i.github,
    created: i.created,
    updated: i.updated,
    links: i.links ?? [],
    description: i.sections.description,
    acceptanceCriteria: i.sections.acceptanceCriteria,
    activity: i.sections.activity,
  };
}
export type IssueJson = ReturnType<typeof issueToJson>;

/**
 * Resolve which workspace root holds `id`, so every command can operate on issues in OTHER repos
 * by id (design jira-sync §5.2):
 *   1. the local workspace (`localRoot`, null outside one), when its own prefix or one of its
 *      `external_prefixes` is the id's prefix;
 *   2. else the only registered workspace that owns or mirrors the prefix;
 *   3. else `not_found` (exit 5), naming every candidate — never a guess.
 */
export async function rootForId(localRoot: string | null, id: string): Promise<string> {
  const prefix = prefixOf(id);
  if (!prefix) {
    // malformed → let readIssue throw a clean error
    if (localRoot) return localRoot;
    throw new HiveError("invalid_arg", `invalid issue id: ${id}`);
  }
  if (localRoot) {
    const cfg = await readConfig(localRoot);
    if (prefix === cfg.prefix || cfg.external_prefixes?.includes(prefix)) return localRoot;
  }
  const roots = await rootsForPrefix(prefix);
  if (roots.length === 1) return roots[0]!;
  if (roots.length === 0) {
    throw new HiveError(
      "not_found",
      `issue ${id} belongs to '${prefix}', which no registered workspace owns or mirrors — open its repo in hivemind once, or run \`hive workspace register\` there`,
    );
  }
  throw new HiveError(
    "not_found",
    `issue ${id}: more than one workspace holds '${prefix}' (${roots.map((r) => path.dirname(r)).join(", ")}) — run the command from inside the one you mean`,
  );
}

/** `rootForId` from where a command runs: the workspace around `cwd` when there is one, else the
 *  registry alone — so `hive show PAY-318` works from any repo, or from outside every one. */
export async function rootForIdHere(id: string, cwd?: string): Promise<string> {
  return rootForId(await findRoot(cwd), id);
}
