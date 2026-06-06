/**
 * Pure decision for "which editor tab is active" — extracted from EditorTile so
 * it's unit-testable without a DOM/Electron. CodeMirror has no tab concept, so
 * tab/active management is entirely ours (see EditorTile header); this is the
 * heart of it.
 *
 * Inputs are the things that can change active selection:
 *  - `tabs` / `prevTabs`: the open-tab list now and on the previous render
 *    (Canvas owns it; deduped — re-opening a file does NOT change it).
 *  - `active`: the currently-active path.
 *  - `req`: an explicit "activate this file" request from a tree click, carrying
 *    a monotonic `seq` so re-selecting an ALREADY-OPEN file is still a fresh
 *    request (the dedupe path adds no tab, so without this the editor would stay
 *    on the other tab — the reported bug).
 *  - `lastSeq`: the seq we last honored, so a request fires exactly once.
 *
 * Precedence: an unhandled activate-request wins (covers re-click of an open
 * file) → else a newly-added tab gets focus (most recent) → else repair a
 * dangling active (tab closed elsewhere) → else keep the current active.
 */
export interface ActiveInput {
  tabs: string[];
  prevTabs: string[];
  active: string | null;
  req: { path: string; seq: number } | null;
  lastSeq: number;
}

export function resolveActive(input: ActiveInput): { active: string | null; seq: number } {
  const { tabs, prevTabs, active, req, lastSeq } = input;

  // 1. Explicit activate request (tree click) we haven't honored yet, whose
  //    target is open. This is the case the dedupe path can't express via `tabs`.
  if (req && req.seq !== lastSeq && tabs.includes(req.path)) {
    return { active: req.path, seq: req.seq };
  }

  // Consume the seq even if we can't act on it (e.g. a brand-new file whose tab
  // hasn't propagated yet — handled by the added-branch below), so it doesn't
  // re-trigger on later unrelated renders.
  const seq = req ? req.seq : lastSeq;

  if (tabs.length === 0) return { active: null, seq };

  // 2. A newly-opened tab gets focus; most-recently-added wins if several land.
  const added = tabs.filter((p) => !prevTabs.includes(p));
  if (added.length > 0) return { active: added[added.length - 1]!, seq };

  // 3. The active tab was closed externally → fall back to the last remaining.
  if (!active || !tabs.includes(active)) {
    return { active: tabs[tabs.length - 1] ?? null, seq };
  }

  // 4. No change.
  return { active, seq };
}
