/**
 * A repo's review comments (the workspace API's `review.*`), kept with its workspace, or in the
 * config directory for a repo that has none (core's `reviewRoot`).
 */
import { ApiError, text } from "@hivemind/workspace-api/protocol";
import { named, type Domain } from "@hivemind/workspace-api/server";
import { normalizeComments, readComments, reviewRoot, writeComments } from "@hivemind/core/review";

export const reviews: Domain<"review.list" | "review.save"> = {
  answers: {
    "review.list": async (_, repo) => readComments(await reviewRoot(text(repo, "repo"))),
    "review.save": async (_, repo, comments) => {
      const r = text(repo, "repo");
      // Saving replaces every comment: what is not a list would save none.
      if (!Array.isArray(comments)) throw new ApiError("BAD_REQUEST", "comments must be a list");
      await writeComments(await reviewRoot(r), normalizeComments(comments));
    },
  },
  effects: {
    "review.save": (repo) => ({ target: named(repo) }),
  },
};
