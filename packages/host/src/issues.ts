/**
 * A workspace's issues (the workspace API's `issue.*`), kept in its `.hivemind` directory (`root`).
 * What a call asks for is checked against core's schemas first (each field as the issue's file
 * holds it), so a malformed call is a bad request that names the field. Each change is signed "ui"
 * in the issue's activity, as the app's window has always signed it, and the agents' context file
 * is written again after it.
 */
import { oneOf, shaped, text, written } from "@hivemind/workspace-api/protocol";
import { named, type Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import { IssuePatchZ, IssueStateZ, LinkTypeZ, NewIssueZ } from "@hivemind/core/types";
import { commentOnIssue, createIssue, deleteIssue, listIssues, readIssue, updateIssue } from "@hivemind/core/storage";
import { linkIssues, transferIssue, unlinkIssues } from "@hivemind/core/cross-repo";
import { writeAgentContext } from "@hivemind/core/agent-context";

type IssueMethod = Extract<Method, `issue.${string}`>;

const rootOf = (v: unknown) => text(v, "root");
const idOf = (v: unknown) => text(v, "id");

/** A change to the workspace's issues, after which the agents' context file is written again. */
async function changed<R>(root: string, change: Promise<R>): Promise<R> {
  const result = await change;
  await writeAgentContext(root);
  return result;
}

/** What a link between two issues is named by in the audit log. */
const between = (id: unknown, other: unknown) => (named(id) && named(other) ? `${id}->${other}` : undefined);

export const issues: Domain<IssueMethod> = {
  answers: {
    "issue.list": (_, root) => listIssues(rootOf(root)),
    "issue.read": (_, root, id) => readIssue(rootOf(root), idOf(id)),
    "issue.create": (_, root, issue) => {
      const r = rootOf(root);
      return changed(r, createIssue(r, shaped(NewIssueZ, issue, "issue")));
    },
    "issue.update": (_, root, id, patch) => {
      const r = rootOf(root);
      return changed(r, updateIssue(r, idOf(id), shaped(IssuePatchZ, patch, "patch"), "ui"));
    },
    "issue.setState": (_, root, id, state, note) => {
      const r = rootOf(root);
      return changed(r, updateIssue(r, idOf(id), { state: shaped(IssueStateZ, state, "state") }, "ui", note == null ? undefined : written(note, "note")));
    },
    "issue.comment": (_, root, id, message) => {
      const r = rootOf(root);
      return changed(r, commentOnIssue(r, idOf(id), text(message, "message"), "ui"));
    },
    "issue.delete": (_, root, id) => {
      const r = rootOf(root);
      return changed(r, deleteIssue(r, idOf(id)));
    },
    "issue.link": (_, root, id, other, type) => linkIssues(rootOf(root), idOf(id), text(other, "other"), shaped(LinkTypeZ, type, "type"), "ui"),
    "issue.unlink": async (_, root, id, other) => ({ removed: await unlinkIssues(rootOf(root), idOf(id), text(other, "other"), "ui") }),
    "issue.move": (_, root, id, prefix, mode) =>
      transferIssue(rootOf(root), idOf(id), text(prefix, "prefix").toUpperCase(), { mode: oneOf(mode, "mode", ["move", "copy"] as const), actor: "ui" }),
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
  },
};
