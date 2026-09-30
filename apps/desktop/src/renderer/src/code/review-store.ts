/**
 * Review-comment persistence + delivery.
 *
 * The comments live in the workspace (main owns the file), not in this
 * renderer: an agent that cannot read localStorage cannot answer a comment,
 * and `hive review` has to see the same list. Both the standalone DiffTile and
 * the Code Workbench's diff read the SAME repo, so a comment shows in either.
 */
import type { ReviewComment } from "../diff-comments";

export async function loadComments(repoPath: string): Promise<ReviewComment[]> {
  return window.hive.reviewList(repoPath).catch(() => []);
}

export async function saveComments(repoPath: string, list: ReviewComment[]): Promise<void> {
  await window.hive.reviewSave(repoPath, list).catch(() => { /* keep the UI usable */ });
}

/** Send review text to claude via the target picker (Canvas routes the event). */
export function deliverToAgent(text: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text } }));
}
