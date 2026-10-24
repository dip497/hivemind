/**
 * A workspace's issues (the workspace API's `issue.*`), kept in its `.hivemind` directory (`root`).
 * What a call asks for is checked against core's schemas first (each field as the issue's file
 * holds it), so a malformed call is a bad request that names the field. Each change is signed in
 * the issue's activity by who made it: "ui" for the person's own windows, as the app has always
 * signed them; a peer by its name (a guest's, a tool plugin's service as `@owner/name (service)`,
 * an agent's tile), never by a name the call gives. The agents' context file is written again
 * after it.
 */
import { ApiError, fields, flag, oneOf, shaped, text, written } from "@hivemind/workspace-api/protocol";
import { named, type Connection, type Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import { IssuePatchZ, IssueStateZ, LinkTypeZ, NewIssueZ } from "@hivemind/core/types";
import { commentOnIssue, createIssue, deleteIssue, listIssues, readIssue, updateIssue } from "@hivemind/core/storage";
import { linkIssues, transferIssue, unlinkIssues } from "@hivemind/core/cross-repo";
import { writeAgentContext } from "@hivemind/core/agent-context";
import { ingestRecords } from "@hivemind/core/ingest";
import { workflowStatuses } from "@hivemind/core/workflow";

type IssueMethod = Extract<Method, `issue.${string}`>;

const rootOf = (v: unknown) => text(v, "root");
const idOf = (v: unknown) => text(v, "id");

/** What names a caller in an issue's activity: a peer's name as the host knows it, else its
 *  program's (a grant's, a tile's), else who it is. */
export type NameOf = (from: Connection) => string | undefined;

/** Who signs a change made over `from`. */
function signer(from: Connection, nameOf: NameOf | undefined): string {
  const { actor } = from;
  // The person: at a window here, or on one of their own devices.
  if (actor.kind !== "peer" || (actor.access === "owner" && !actor.client)) return "ui";
  return nameOf?.(from)?.trim() || actor.client || actor.person;
}

/** A change to the workspace's issues, after which the agents' context file is written again. */
async function changed<R>(root: string, change: Promise<R>): Promise<R> {
  const result = await change;
  await writeAgentContext(root);
  return result;
}

/** What a link between two issues is named by in the audit log. */
const between = (id: unknown, other: unknown) => (named(id) && named(other) ? `${id}->${other}` : undefined);

/** The issues domain; `nameOf` names a peer (a guest by the name they joined with). */
export const issuesDomain = (nameOf?: NameOf): Domain<IssueMethod> => ({
  answers: {
    "issue.list": (_, root) => listIssues(rootOf(root)),
    "issue.read": (_, root, id) => readIssue(rootOf(root), idOf(id)),
    "issue.workflow": (_, root) => workflowStatuses(rootOf(root)),
    "issue.create": (from, root, issue) => {
      const r = rootOf(root);
      return changed(r, createIssue(r, { ...shaped(NewIssueZ, issue, "issue"), who: signer(from, nameOf) }));
    },
    "issue.update": (from, root, id, patch) => {
      const r = rootOf(root);
      return changed(r, updateIssue(r, idOf(id), shaped(IssuePatchZ, patch, "patch"), signer(from, nameOf)));
    },
    "issue.setState": (from, root, id, state, note) => {
      const r = rootOf(root);
      return changed(r, updateIssue(r, idOf(id), { state: shaped(IssueStateZ, state, "state") }, signer(from, nameOf), note == null ? undefined : written(note, "note")));
    },
    "issue.comment": (from, root, id, message) => {
      const r = rootOf(root);
      return changed(r, commentOnIssue(r, idOf(id), text(message, "message"), signer(from, nameOf)));
    },
    "issue.delete": (_, root, id) => {
      const r = rootOf(root);
      return changed(r, deleteIssue(r, idOf(id)));
    },
    "issue.link": (from, root, id, other, type) => linkIssues(rootOf(root), idOf(id), text(other, "other"), shaped(LinkTypeZ, type, "type"), signer(from, nameOf)),
    "issue.unlink": async (from, root, id, other) => ({ removed: await unlinkIssues(rootOf(root), idOf(id), text(other, "other"), signer(from, nameOf)) }),
    "issue.move": (from, root, id, prefix, mode) =>
      transferIssue(rootOf(root), idOf(id), text(prefix, "prefix").toUpperCase(), { mode: oneOf(mode, "mode", ["move", "copy"] as const), actor: signer(from, nameOf) }),
    "issue.ingest": (_, root, source, records, opts) => {
      const r = rootOf(root);
      if (!Array.isArray(records)) throw new ApiError("BAD_REQUEST", "records must be a list");
      const dryRun = opts == null ? false : flag(fields(opts, "opts").dryRun, "opts.dryRun") === true;
      // A record that doesn't parse is the caller's to fix, and nothing was written.
      const run = ingestRecords(r, text(source, "source"), records, { dryRun }).catch((e: unknown) => {
        const code = (e as { code?: unknown })?.code;
        throw code === "bad_request" || code === "invalid_arg" ? new ApiError("BAD_REQUEST", (e as Error).message) : e;
      });
      return dryRun ? run : changed(r, run);
    },
  },
  effects: {
    "issue.create": () => ({ target: (issue: { id?: string } | null) => issue?.id }),
    "issue.update": (_root, id) => ({ target: named(id) }),
    "issue.setState": (_root, id, state) => ({ target: named(id), detail: named(state) }),
    "issue.comment": (_root, id) => ({ target: named(id) }),
    "issue.delete": (_root, id) => ({ target: named(id) }),
    "issue.link": (_root, id, other, type) => ({ target: between(id, other), detail: named(type) }),
    "issue.unlink": (_root, id, other) => ({ target: between(id, other) }),
    "issue.move": (_root, id, prefix, mode) => ({ target: named(id), detail: named(prefix) && `${mode === "copy" ? "copy" : "move"} to ${named(prefix)!.toUpperCase()}` }),
    "issue.ingest": (_root, source) => ({ target: named(source) }),
  },
});
