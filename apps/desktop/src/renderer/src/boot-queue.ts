/**
 * Agent tiles restored together take turns starting.
 *
 * Every agent tile runs a CLI that starts its own helper servers. Restoring a workspace
 * after a reboot started all of them in the same second and pinned every core for a
 * minute. Restored tiles now boot a few at a time; the rest wait with a skeleton. A tile
 * holds its slot until it has settled (drawn its prompt and gone quiet) or a cap passes.
 *
 * Only RESTORED tiles queue. A tile the person just spawned starts immediately, and a
 * restored tile whose session is still alive re-attaches without queueing at all.
 */

// ponytail: fixed share of the cores; a setting if anyone needs to tune it.
const LIMIT = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 8) / 4)));

const restored = new Set<string>();
let running = 0;
const waiting: { id: string; go: () => void }[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Tiles that were on the canvas when it loaded, as opposed to spawned since. */
export function markRestored(ids: Iterable<string>): void {
  for (const id of ids) restored.add(id);
}
export function isRestored(id: string): boolean {
  return restored.has(id);
}

/** Wait for a boot slot. Resolves with the function that gives it back (idempotent). */
export function acquireBoot(id: string): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      running++;
      notify();
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        running--;
        restored.delete(id); // a respawn later is the person's, not a restore
        const next = waiting.shift();
        if (next) next.go(); else notify();
      });
    };
    if (running < LIMIT) grant();
    else { waiting.push({ id, go: grant }); notify(); }
  });
}

/** Leave the line without ever starting (the tile closed while it waited). */
export function cancelBoot(id: string): void {
  const i = waiting.findIndex((w) => w.id === id);
  if (i >= 0) { waiting.splice(i, 1); notify(); }
}

/** How many tiles start before this one; null when it is not waiting. */
export function bootPosition(id: string): number | null {
  const i = waiting.findIndex((w) => w.id === id);
  return i < 0 ? null : i;
}

export function subscribeBoot(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
