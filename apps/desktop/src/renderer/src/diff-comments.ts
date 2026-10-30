/**
 * Pure data model + migration for DiffTile review comments. Kept separate from
 * DiffTile.tsx (which pulls in the whole Pierre/React tree) so it's unit-testable
 * in isolation. Its types are core's, type-only → erased at runtime.
 */
import type { DiffComment, ReviewReply as CoreReply } from "@hivemind/core/review-shape";

export type ReviewReply = CoreReply;

/** A review comment spans [startLine, endLine] (equal for a single line). */
export type ReviewComment = DiffComment;

let cidSeq = 0;
export const newCid = (): string => `c-${Date.now().toString(36)}-${(cidSeq++).toString(36)}`;

const rangeStr = (c: ReviewComment): string =>
  c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;

/** One comment → the message sent to claude ("Address this review comment …"). */
export function formatCommentMessage(c: ReviewComment): string {
  const thread = [c.body, ...(c.replies ?? []).map((r) => `  ↳ ${r.author}: ${r.body}`)].join("\n");
  return `Address this review comment — ${c.file}:${rangeStr(c)}:\n${thread}`;
}

/** A batch of comments → one review message (unresolved only). null if none. */
export function formatReviewMessage(comments: ReviewComment[]): string | null {
  const open = comments.filter((c) => !c.resolved);
  if (open.length === 0) return null;
  const lines = open
    .map((c) => {
      const side = c.side === "deletions" ? "old/left" : "new/right";
      const thread = (c.replies ?? []).map((r) => ` ↳ ${r.author}: ${r.body}`).join("\n");
      return `- ${c.file}:${rangeStr(c)} (${side}): ${c.body}${thread ? "\n" + thread : ""}`;
    })
    .join("\n");
  return `Code review — ${open.length} unresolved comment${open.length > 1 ? "s" : ""} to address:\n${lines}`;
}
