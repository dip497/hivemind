/**
 * How a plugin is found by words, the same on HiveHub, in the app and in `hive plugins search`:
 * every word typed must start a word of the plugin's name, id, category or description. The best
 * have the words in the name, then the id, the category, the description, and a whole word counts
 * more than the start of a longer one ("pr" is closer to "prs" than to "progress"); then the most
 * installed.
 */
import { CATEGORY_LABELS, type PluginCategory } from "@hivemind/view-sdk/category";

export interface Searchable { id: string; name: string; description?: string | null; category?: string | null; installs?: number }

/** Lower-case words of letters and digits: "@ada/github-prs" is ada, github, prs. */
export const searchWords = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const NAME = 8, ID = 4, CATEGORY = 2, DESCRIPTION = 1;

/** How well `p` matches the query's words, or null when one of them starts no word of it. */
export function matchScore(words: readonly string[], p: Searchable): number | null {
  const label = p.category ? CATEGORY_LABELS[p.category as PluginCategory] ?? "" : "";
  // A word that starts a word is in the text: most plugins are ruled out before being split.
  const text = `${p.name} ${p.id} ${p.category ?? ""} ${label} ${p.description ?? ""}`.toLowerCase();
  if (!words.every((w) => text.includes(w))) return null;
  const fields: [number, string[]][] = [
    [NAME, searchWords(p.name)],
    [ID, searchWords(p.id)],
    [CATEGORY, searchWords(`${p.category ?? ""} ${label}`)],
    [DESCRIPTION, searchWords(p.description ?? "")],
  ];
  let score = 0;
  for (const w of words) {
    let best = 0;
    for (const [weight, list] of fields) for (const t of list) if (t.startsWith(w)) best = Math.max(best, weight * w.length / t.length);
    if (!best) return null;
    score += best;
  }
  return score;
}

/** The plugins the query finds, best first. An empty query finds every one, most installed first. */
export function searchPlugins<T extends Searchable>(list: readonly T[], query: string): T[] {
  const words = searchWords(query);
  return list.flatMap((p) => { const score = matchScore(words, p); return score === null ? [] : [{ p, score }]; })
    .sort((a, b) => b.score - a.score || (b.p.installs ?? 0) - (a.p.installs ?? 0) || a.p.name.localeCompare(b.p.name))
    .map(({ p }) => p);
}

/** Whether every word of the query starts a word of `text`: for lists that keep their own order. */
export const textMatches = (query: string, text: string): boolean =>
  matchScore(searchWords(query), { id: "", name: text }) !== null;
