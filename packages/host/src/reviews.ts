/**
 * A repo's review comments (the workspace API's `review.*`), kept with its workspace, or in the
 * config directory for a repo that has none (core's `reviewRoot`).
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import { named, type Domain } from "@hivemind/workspace-api/server";
import type { Method } from "@hivemind/workspace-api/methods";
import {
  deleteComment, dismissComment, editComment, markSeen, normalizeComments, onPage, readComments, reopenComment, replyTo,
  resolveComment, reviewRoot, writeComments, type ReviewComment,
} from "@hivemind/core/review";
import { HiveError } from "@hivemind/core/storage";

type ReviewMethod = Extract<Method, `review.${string}`>;

const idOf = (v: unknown) => text(v, "id");

/** One comment changed; a comment not there, or not where the change starts from, is refused. */
async function one(repo: unknown, id: unknown, change: (root: string, id: string) => Promise<ReviewComment | null>): Promise<ReviewComment> {
  const root = await reviewRoot(text(repo, "repo"));
  try {
    const c = await change(root, idOf(id));
    if (!c) throw new ApiError("NOT_FOUND", `no comment ${String(id)}`);
    return c;
  } catch (e) {
    if (e instanceof HiveError) throw new ApiError("BAD_REQUEST", e.message);
    throw e;
  }
}

export const reviews: Domain<ReviewMethod> = {
  answers: {
    "review.list": async (_, repo) => readComments(await reviewRoot(text(repo, "repo"))),
    "review.save": async (_, repo, comments) => {
      const root = await reviewRoot(text(repo, "repo"));
      // Saving replaces every comment on a diff: what is not a list would save none.
      if (!Array.isArray(comments)) throw new ApiError("BAD_REQUEST", "comments must be a list");
      const saved = normalizeComments(comments).filter((c) => !onPage(c));
      await writeComments(root, [...saved, ...(await readComments(root)).filter(onPage)]);
    },
    "review.seen": (_, repo, id) => one(repo, id, markSeen),
    "review.resolve": (_, repo, id, summary) => one(repo, id, (r, i) => resolveComment(r, i, summary == null ? undefined : text(summary, "summary"))),
    "review.dismiss": (_, repo, id, reason) => one(repo, id, (r, i) => dismissComment(r, i, text(reason, "reason"))),
    "review.reopen": (_, repo, id) => one(repo, id, reopenComment),
    "review.reply": (_, repo, id, body) => one(repo, id, (r, i) => replyTo(r, i, { author: "you", body: text(body, "body"), at: new Date().toISOString() })),
    "review.edit": (_, repo, id, body) => one(repo, id, (r, i) => editComment(r, i, text(body, "body"))),
    "review.delete": async (_, repo, id) => {
      if (!(await deleteComment(await reviewRoot(text(repo, "repo")), idOf(id)))) throw new ApiError("NOT_FOUND", `no comment ${String(id)}`);
    },
  },
  effects: {
    "review.save": (repo) => ({ target: named(repo) }),
    "review.seen": (_repo, id) => ({ target: named(id) }),
    "review.resolve": (_repo, id) => ({ target: named(id) }),
    "review.dismiss": (_repo, id) => ({ target: named(id) }),
    "review.reopen": (_repo, id) => ({ target: named(id) }),
    "review.reply": (_repo, id) => ({ target: named(id) }),
    "review.edit": (_repo, id) => ({ target: named(id) }),
    "review.delete": (_repo, id) => ({ target: named(id) }),
  },
};
