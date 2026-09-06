/**
 * JSON projections + cross-repo id resolution shared by every hive front end
 * (`hive ctl …`, the desktop). One place, so `hive ctl get-issue --json` and
 * the desktop render the same shape for the same issue.
 */
import type { Issue } from "./types.js";
import { readConfig } from "./storage.js";
import { prefixOf, resolveWorkspaceByPrefix } from "./registry.js";

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

/** Resolve which workspace root owns `id`. If the id's prefix matches the local
 *  workspace, returns `localRoot`; otherwise resolves the owning repo via the
 *  registry — so every command can operate on issues in OTHER repos by id. */
export async function rootForId(localRoot: string, id: string): Promise<string> {
  const prefix = prefixOf(id);
  if (!prefix) return localRoot; // malformed → let readIssue throw a clean error
  const localPrefix = (await readConfig(localRoot)).prefix;
  if (prefix === localPrefix) return localRoot;
  const ws = await resolveWorkspaceByPrefix(prefix);
  if (!ws) {
    throw new Error(
      `issue ${id} belongs to workspace '${prefix}', which isn't registered — open it in hivemind once, or run \`hive workspace register\` in that repo`,
    );
  }
  return ws.root;
}
