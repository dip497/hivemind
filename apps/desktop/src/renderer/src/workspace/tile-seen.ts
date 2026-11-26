/**
 * When this person last looked at each tile, as the Layers panel keeps it (its `seen`, kept with the
 * person's own layout): published here as it changes, so a view is told the same times (view
 * protocol 1.21, `status.seen`) and marks a tile unread exactly when Layers does.
 */

let seen: Readonly<Record<string, number>> = {};
const listeners = new Set<() => void>();

/** The panel's times, the same object while nothing changed. */
export function publishTileSeen(next: Readonly<Record<string, number>> | undefined): void {
  const now = next ?? {};
  if (now === seen) return;
  seen = now;
  for (const l of listeners) l();
}

/** When the person last looked at `tileId` (null: not yet), now and when it changes. */
export function followTileSeen(tileId: string, cb: (at: number | null) => void): () => void {
  let last: number | null | undefined;
  const tell = () => {
    const at = seen[tileId] ?? null;
    if (at === last) return;
    last = at;
    cb(at);
  };
  listeners.add(tell);
  tell();
  return () => { listeners.delete(tell); };
}
