/**
 * The task a tile is spawned with, waiting for the tile to be ready for it.
 *
 * A tile spawned with a task does not exist yet when the task is written (and a frame picker
 * can sit in between), and the agent takes a variable few seconds to reach its prompt. So the
 * task is queued against the new tile's id, and the tile delivers it to itself once it is
 * genuinely ready (TerminalTile). The tile claims it exactly once.
 */
interface PendingWork { text: string; at: number; }
// One map for the window, not one per module instance: a tile's body can be mounted twice at
// once (React mounts every component twice in development, and a hot reload brings a second
// copy of this module with it), and a queue per copy means the same task claimed — and
// submitted — twice.
const pendingWork: Map<string, PendingWork> =
  ((globalThis as { __hmPendingWork?: Map<string, PendingWork> }).__hmPendingWork ??=
    new Map<string, PendingWork>());
/** A spawn that never reaches ready within this window is abandoned (the agent is missing, or
 *  the tile was closed before it booted). */
const WORK_TTL_MS = 120_000;

/** Queue a task to deliver to `tileId` once it first becomes ready. */
export function queueWork(tileId: string, text: string): void {
  if (text) pendingWork.set(tileId, { text, at: Date.now() });
}

/** One-shot claim: the queued task for this tile (removed on read; undefined if none or stale). */
export function claimWork(tileId: string): string | undefined {
  const w = pendingWork.get(tileId);
  if (!w) return undefined;
  pendingWork.delete(tileId);
  return Date.now() - w.at > WORK_TTL_MS ? undefined : w.text;
}

/** The queued task without consuming it. */
export function peekWork(tileId: string): string | undefined {
  const w = pendingWork.get(tileId);
  if (!w) return undefined;
  if (Date.now() - w.at > WORK_TTL_MS) { pendingWork.delete(tileId); return undefined; }
  return w.text;
}

/** The tile is gone: its task has nowhere to land. */
export function clearWork(tileId: string): void {
  pendingWork.delete(tileId);
}
