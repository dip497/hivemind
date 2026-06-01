/**
 * Cross-repo issue operations — transfer (move/copy) and link issues across
 * workspaces, resolved through the workspace registry. Built on the insight
 * that a full issue id (`MANAGEARK-3`) is globally unique because its prefix
 * names the workspace, so any id is its own cross-repo address.
 *
 * Markdown files stay the source of truth; these helpers just read/write issue
 * files in two roots and keep both ends of a relationship consistent.
 */
import {
  HiveError,
  appendActivity,
  allocateId,
  deleteIssueFile,
  issuePath,
  listIssues,
  readIssue,
  writeIssue,
} from "./storage.js";
import { writeAgentContext } from "./agent-context.js";
import { prefixOf, resolveWorkspaceByPrefix } from "./registry.js";
import type { Issue, IssueLink, LinkType } from "./types.js";

/** The reciprocal relationship recorded on the *other* end of a link. */
export function reciprocalLinkType(t: LinkType): LinkType {
  switch (t) {
    case "blocks":
      return "blocked-by";
    case "blocked-by":
      return "blocks";
    case "parent-of":
      return "child-of";
    case "child-of":
      return "parent-of";
    case "moved-to":
      return "moved-from";
    case "moved-from":
      return "moved-to";
    case "relates":
    case "duplicates":
    default:
      return t; // symmetric
  }
}

/** Add a link to an issue in memory (dedupe by id+type). Returns true if added. */
function addLink(issue: Issue, link: IssueLink): boolean {
  const links = issue.links ?? [];
  if (links.some((l) => l.id === link.id && l.type === link.type)) return false;
  issue.links = [...links, link];
  return true;
}

/** Remove every link to `targetId` from an issue (any type). Returns count. */
function removeLinksTo(issue: Issue, targetId: string): number {
  const links = issue.links ?? [];
  const kept = links.filter((l) => l.id !== targetId);
  issue.links = kept;
  return links.length - kept.length;
}

/** Resolve `.hivemind` root for the workspace owning `id`, or throw a helpful
 *  HiveError naming the missing workspace. */
async function rootForIdOrThrow(id: string): Promise<string> {
  const prefix = prefixOf(id);
  if (!prefix) throw new HiveError("invalid_arg", `malformed issue id: ${id}`);
  const ws = await resolveWorkspaceByPrefix(prefix);
  if (!ws) {
    throw new HiveError(
      "unknown_workspace",
      `no registered workspace for prefix '${prefix}' (from ${id}) — open it in hivemind or run \`hive workspace register\` in that repo`,
    );
  }
  return ws.root;
}

/** Resolve an issue ref that may live in another workspace. Returns the owning
 *  root + the loaded Issue. Throws if the workspace or issue is unknown. */
export async function resolveIssueRef(id: string): Promise<{ root: string; issue: Issue }> {
  const root = await rootForIdOrThrow(id);
  const issue = await readIssue(root, id);
  return { root, issue };
}

export interface LinkResult {
  from: string;
  to: string;
  type: LinkType;
  reciprocal: LinkType;
}

/**
 * Link two issues (possibly in different repos). Records `type` on `fromId` and
 * the reciprocal on `toId`, writing both files. `toId`'s workspace is resolved
 * via the registry from its prefix. `fromRoot` is the source workspace root.
 */
export async function linkIssues(
  fromRoot: string,
  fromId: string,
  toId: string,
  type: LinkType,
  actor = "agent",
): Promise<LinkResult> {
  if (fromId === toId) throw new HiveError("invalid_arg", `cannot link ${fromId} to itself`);
  const from = await readIssue(fromRoot, fromId);
  const toRoot = await rootForIdOrThrow(toId);
  const to = await readIssue(toRoot, toId); // verifies it exists
  const recip = reciprocalLinkType(type);

  const aChanged = addLink(from, { id: toId, type });
  const bChanged = addLink(to, { id: fromId, type: recip });
  if (aChanged) {
    appendActivity(from, actor, `link ${type} → ${toId}`);
    await writeIssue(from);
  }
  if (bChanged) {
    appendActivity(to, actor, `link ${recip} → ${fromId}`);
    await writeIssue(to);
  }
  // Refresh agent context on both sides so the linked relationship surfaces.
  await writeAgentContext(fromRoot).catch(() => {});
  if (toRoot !== fromRoot) await writeAgentContext(toRoot).catch(() => {});
  return { from: fromId, to: toId, type, reciprocal: recip };
}

/** Remove all links between two issues (both ends). Returns total removed. */
export async function unlinkIssues(
  fromRoot: string,
  fromId: string,
  toId: string,
  actor = "agent",
): Promise<number> {
  const from = await readIssue(fromRoot, fromId);
  let removed = removeLinksTo(from, toId);
  if (removed > 0) {
    appendActivity(from, actor, `unlink → ${toId}`);
    await writeIssue(from);
  }
  try {
    const toRoot = await rootForIdOrThrow(toId);
    const to = await readIssue(toRoot, toId);
    const r2 = removeLinksTo(to, fromId);
    if (r2 > 0) {
      appendActivity(to, actor, `unlink → ${fromId}`);
      await writeIssue(to);
      removed += r2;
    }
  } catch {
    /* other end gone/unknown — source side already cleaned */
  }
  return removed;
}

export interface TransferResult {
  newId: string;
  newIssue: Issue;
  mode: "move" | "copy";
  from: string;
}

/**
 * Transfer an issue into another workspace.
 *
 * - **copy**: a fresh issue is created in the destination (new id from the
 *   dest prefix), carrying title/description/labels/acceptance/state. Both
 *   issues get a reciprocal `relates` link. The source stays.
 * - **move**: same creation, but the source issue is then deleted. The new
 *   issue records `moved-from: <oldId>` as provenance.
 *
 * `destPrefix` is resolved to a root via the registry. Refuses to move an issue
 * that has sub-issues (their files would be orphaned) — move/copy children
 * first, or use copy.
 */
export async function transferIssue(
  srcRoot: string,
  id: string,
  destPrefix: string,
  opts: { mode: "move" | "copy"; actor?: string },
): Promise<TransferResult> {
  const actor = opts.actor ?? "agent";
  const ws = await resolveWorkspaceByPrefix(destPrefix);
  if (!ws) {
    throw new HiveError(
      "unknown_workspace",
      `no registered workspace with prefix '${destPrefix}' — open it in hivemind or run \`hive workspace register\` there`,
    );
  }
  const destRoot = ws.root;
  if (destRoot === srcRoot) {
    throw new HiveError("invalid_arg", `${id} is already in workspace '${destPrefix}'`);
  }
  const src = await readIssue(srcRoot, id);

  if (opts.mode === "move") {
    const all = await listIssues(srcRoot);
    const hasChildren = all.some((i) => i.parent === id || i.id.startsWith(`${id}.`));
    if (hasChildren) {
      throw new HiveError(
        "has_children",
        `${id} has sub-issues — move/copy them first, or use copy (move would orphan their files)`,
      );
    }
  }

  // Allocate a fresh top-level id in the destination workspace.
  const { id: newId } = await allocateId(destRoot);
  const now = new Date().toISOString();
  const provenance: IssueLink =
    opts.mode === "move"
      ? { id, type: "moved-from" }
      : { id, type: "relates" };
  const newIssue: Issue = {
    id: newId,
    title: src.title,
    state: src.state,
    parent: null, // cross-repo parent isn't valid; the link carries the relation
    labels: src.labels,
    assignee: src.assignee,
    github: null,
    links: [provenance],
    created: now,
    updated: now,
    path: "", // set by writeIssue via issuePath below
    sections: {
      description: src.sections.description,
      acceptanceCriteria: src.sections.acceptanceCriteria.map((a) => ({ ...a })),
      activity: [
        {
          at: now.replace("T", " ").slice(0, 16),
          who: actor,
          message: `${opts.mode === "move" ? "moved" : "copied"} from ${id} (${prefixOf(id)})`,
        },
      ],
      extra: "",
    },
    raw: "",
  };
  // writeIssue needs a concrete path; derive it the same way createIssue does.
  newIssue.path = issuePath(destRoot, newId);
  await writeIssue(newIssue);
  await writeAgentContext(destRoot).catch(() => {});

  if (opts.mode === "copy") {
    // Reciprocal link back from the source so both boards show the relation.
    addLink(src, { id: newId, type: "relates" });
    appendActivity(src, actor, `copied to ${newId} (${destPrefix})`);
    await writeIssue(src);
    await writeAgentContext(srcRoot).catch(() => {});
  } else {
    await deleteIssueFile(srcRoot, id);
    await writeAgentContext(srcRoot).catch(() => {});
  }

  return { newId, newIssue, mode: opts.mode, from: id };
}

/** Resolve and summarize an issue's links into a display-friendly shape:
 *  each entry annotated with whether its target is reachable + its title. */
export async function resolveLinks(
  issue: Issue,
): Promise<Array<{ id: string; type: LinkType; title: string | null; reachable: boolean }>> {
  const out: Array<{ id: string; type: LinkType; title: string | null; reachable: boolean }> = [];
  for (const l of issue.links ?? []) {
    try {
      const { issue: target } = await resolveIssueRef(l.id);
      out.push({ id: l.id, type: l.type, title: target.title, reachable: true });
    } catch {
      out.push({ id: l.id, type: l.type, title: null, reachable: false });
    }
  }
  return out;
}
