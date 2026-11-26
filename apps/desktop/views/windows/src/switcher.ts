/**
 * What the Windows view's quick switcher lists, and what its groups hold: pure, so the order a
 * person sees is tested apart from the page.
 */
import { attentionRank, type Attention } from "@hivemind/core/attention";

export interface Entry {
  id: string;
  title: string;
  agent?: string;
  /** Its frame's folder or title. */
  folder?: string;
}

/** How well `query` matches `text` as letters in order, or null when it does not. Letters that
 *  start a word and letters in a row count more, so "fe" finds "front end" before "safe". */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let last = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const start = i === 0 || !/[\p{L}\p{N}]/u.test(t[i - 1]!);
    score += 1 + (start ? 3 : 0) + (i === last + 1 ? 2 : 0);
    last = i;
    from = i + 1;
  }
  return score / (1 + t.length / 40);
}

/**
 * The switcher's list: what matches the query (by title, agent or folder); those that need the
 * person first, the most recent of them first; then the best match; then the most recently shown.
 */
export function rankEntries(
  entries: readonly Entry[],
  query: string,
  attention: (id: string) => Attention,
  recent: readonly string[],
  needsSince: (id: string) => number = () => 0,
): Entry[] {
  const order = new Map(recent.map((id, i) => [id, i]));
  const scored = entries.flatMap((e) => {
    const score = Math.max(...[e.title, e.agent ?? "", e.folder ?? ""].map((s) => fuzzyScore(query, s) ?? -1));
    return score < 0 ? [] : [{ e, score, needs: attention(e.id) === "needs-you" }];
  });
  return scored.sort((a, b) =>
    Number(b.needs) - Number(a.needs)
    || (a.needs ? needsSince(b.e.id) - needsSince(a.e.id) : 0)
    || b.score - a.score
    || (order.get(a.e.id) ?? Infinity) - (order.get(b.e.id) ?? Infinity)
    || attentionRank(attention(a.e.id)) - attentionRank(attention(b.e.id)))
    .map((s) => s.e);
}

/** `id` first in the recent order, the rest after it as they were. Same list back when it is first. */
export function touch(recent: readonly string[], id: string): readonly string[] {
  return recent[0] === id ? recent : [id, ...recent.filter((x) => x !== id)];
}

/** A frame as the switcher and the group strip see it. */
export interface GroupFrame { id: string; title: string; parentId?: string; page?: true }

/** The page a frame is on, or null for the top level: the nearest frame at or above it that opens
 *  into a page. */
export function pageOf(frames: ReadonlyMap<string, GroupFrame>, frameId: string | null): string | null {
  const seen = new Set<string>();
  for (let f = frameId ? frames.get(frameId) : undefined; f && !seen.has(f.id); f = f.parentId ? frames.get(f.parentId) : undefined) {
    seen.add(f.id);
    if (f.page) return f.id;
  }
  return null;
}

export type GroupBy = "frame" | "page";
export interface Group { key: string; label: string; tiles: string[] }

/** The tiles in groups, in the order the tiles come: by their frame, or by the page they are on.
 *  Tiles in no frame (or on no page) are the group with key `frame:` (`page:`). */
export function groupTiles(
  tiles: readonly { id: string; frameId: string | null }[],
  frames: ReadonlyMap<string, GroupFrame>,
  by: GroupBy,
): Group[] {
  const groups = new Map<string, Group>();
  for (const t of tiles) {
    const owner = by === "frame" ? t.frameId : pageOf(frames, t.frameId);
    const key = `${by}:${owner ?? ""}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, label: owner ? frames.get(owner)?.title ?? owner : by === "frame" ? "No frame" : "Top level", tiles: [] }));
    g.tiles.push(t.id);
  }
  return [...groups.values()];
}
