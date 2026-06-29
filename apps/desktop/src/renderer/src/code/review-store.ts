/**
 * Review-comment persistence + delivery — the DOM/localStorage side of the diff
 * review model (kept out of the pure, unit-tested diff-comments.ts). Both the
 * standalone DiffTile and the Code Workbench's diff read/write the SAME key, so a
 * comment shows in either surface.
 */
import { normalizeComments, type ReviewComment } from "../diff-comments";

export const COMMENTS_KEY_PREFIX = "hivemind:comments:";

export function loadComments(repoPath: string): ReviewComment[] {
  try {
    const raw = localStorage.getItem(COMMENTS_KEY_PREFIX + repoPath);
    return normalizeComments(raw ? JSON.parse(raw) : []);
  } catch { return []; }
}

export function saveComments(repoPath: string, list: ReviewComment[]): void {
  try { localStorage.setItem(COMMENTS_KEY_PREFIX + repoPath, JSON.stringify(list)); } catch { /* quota */ }
}

/** Send review text to claude via the target picker (Canvas routes the event). */
export function deliverToClaude(text: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text } }));
}
