import { listIssues, type IssueSummary } from "@hivemind/core";

/**
 * Find the next sibling sub-issue ID under a parent. For parent "PAY-122"
 * with existing children [PAY-122.1, PAY-122.3], returns "PAY-122.4".
 * For parent "PAY-122.1" with no children, returns "PAY-122.1.1".
 */
export async function findNextChildId(root: string, parentId: string): Promise<string> {
  const all = await listIssues(root);
  const prefix = parentId + ".";
  const siblings = all
    .map((i: IssueSummary) => i.id)
    .filter((id) => id.startsWith(prefix))
    .map((id) => {
      const tail = id.slice(prefix.length);
      // Only direct children (no further dots).
      if (tail.includes(".")) return null;
      const n = Number(tail);
      return Number.isInteger(n) ? n : null;
    })
    .filter((n): n is number => n !== null);
  const next = siblings.length === 0 ? 1 : Math.max(...siblings) + 1;
  return `${parentId}.${next}`;
}
