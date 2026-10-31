/**
 * Review-comment persistence + delivery.
 *
 * The comments live in the workspace (main owns the file), not in this
 * renderer: an agent that cannot read localStorage cannot answer a comment,
 * and `hive review` has to see the same list. Both the standalone DiffTile and
 * the Code Workbench's diff read the SAME repo, so a comment shows in either.
 */
import type { ReviewComment } from "../diff-comments";
import { onDiff, type ReviewComment as Comment } from "@hivemind/core/review-shape";

/** The repo's comments on a diff; its notes on pages are the Browser tile's. */
export async function loadComments(repoPath: string): Promise<ReviewComment[]> {
  const all: Comment[] = await window.hive.reviewList(repoPath).catch(() => []);
  return all.filter(onDiff);
}

export async function saveComments(repoPath: string, list: ReviewComment[]): Promise<void> {
  await window.hive.reviewSave(repoPath, list).catch(() => { /* keep the UI usable */ });
}

/** Send review text to an agent via the target picker (Canvas routes the event). */
export function deliverToAgent(text: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:deliver-to-agent", { detail: { text } }));
}
