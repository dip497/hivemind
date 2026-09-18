/**
 * Review-comment persistence + delivery.
 *
 * The comments live in the workspace (main owns the file), not in this
 * renderer: an agent that cannot read localStorage cannot answer a comment,
 * and `hive review` has to see the same list. Both the standalone DiffTile and
 * the Code Workbench's diff read the SAME repo, so a comment shows in either.
 */
import { normalizeComments, type ReviewComment } from "../diff-comments";

export const COMMENTS_KEY_PREFIX = "hivemind:comments:";

/** Comments this renderer wrote before the store moved out of localStorage.
 *  Imported once per repo, then the key is dropped. */
function takeLegacy(repoPath: string): ReviewComment[] {
  try {
    const raw = localStorage.getItem(COMMENTS_KEY_PREFIX + repoPath);
    if (!raw) return [];
    localStorage.removeItem(COMMENTS_KEY_PREFIX + repoPath);
    return normalizeComments(JSON.parse(raw));
  } catch { return []; }
}

export async function loadComments(repoPath: string): Promise<ReviewComment[]> {
  const stored = normalizeComments(await window.hive.reviewList(repoPath).catch(() => []));
  const legacy = takeLegacy(repoPath).filter((c) => !stored.some((s) => s.id === c.id));
  if (legacy.length === 0) return stored;
  const merged = [...stored, ...legacy];
  await saveComments(repoPath, merged);
  return merged;
}

export async function saveComments(repoPath: string, list: ReviewComment[]): Promise<void> {
  await window.hive.reviewSave(repoPath, list).catch(() => { /* keep the UI usable */ });
}

/** Send review text to claude via the target picker (Canvas routes the event). */
export function deliverToClaude(text: string): void {
  window.dispatchEvent(new CustomEvent("hivemind:deliver-to-claude", { detail: { text } }));
}
