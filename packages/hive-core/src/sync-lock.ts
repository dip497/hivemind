// One writer per source (design jira-sync §5.3): `.hivemind/sync/<source-slug>/lock` names the process
// syncing that source — pid, machine and a heartbeat it refreshes while it works. A second sync of
// the same source is refused while the holder is alive. A holder that is gone is taken over, with a
// note saying so: a dead pid on this machine, or (for a holder on another machine sharing the folder)
// a heartbeat older than `staleAfterMs`.
//
// The lock file is only ever read and changed under `withLock` (settings.ts), the cross-process
// lock every other shared file of the app's uses, so two syncs starting at once can't both take it.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withLock } from "./settings.js";
import { syncDir } from "./mirror.js";

export interface SyncLockHolder {
  pid: number;
  machine: string;
  /** When it took the lock, and when it last said it was still working (ISO). */
  since: string;
  heartbeat: string;
  token: string;
}

export class SyncLockedError extends Error {
  readonly code = "sync_locked";
  constructor(readonly source: string, readonly holder: SyncLockHolder) {
    super(`${source} is being synced by pid ${holder.pid} on ${holder.machine} (since ${holder.since}, last heartbeat ${holder.heartbeat})`);
    this.name = "SyncLockedError";
  }
}

export interface SyncLockOptions {
  /** How often the heartbeat is refreshed while `work` runs. */
  heartbeatMs?: number;
  /** A heartbeat older than this is a holder that is gone. */
  staleAfterMs?: number;
  /** Hears why a stale lock was taken over. */
  onTakeover?: (note: string) => void;
}

const HEARTBEAT_MS = 10_000;
const STALE_AFTER_MS = 120_000;

export const syncLockPath = (root: string, source: string): string => path.join(syncDir(root, source), "lock");

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readHolder(file: string): Promise<SyncLockHolder | null> {
  try {
    const h = JSON.parse(await fs.readFile(file, "utf8")) as SyncLockHolder;
    return typeof h?.pid === "number" && typeof h.token === "string" ? h : null;
  } catch {
    return null; // missing, or torn by a holder that died mid-write: nobody holds it
  }
}

/** Why `h` no longer holds the lock, or null while it does. */
function staleBecause(h: SyncLockHolder, staleAfterMs: number): string | null {
  if (h.machine === os.hostname() && !alive(h.pid)) return `pid ${h.pid} on this machine is gone`;
  const age = Date.now() - Date.parse(h.heartbeat);
  if (!(age <= staleAfterMs)) return `its last heartbeat was ${Math.round(age / 1000)}s ago`;
  return null;
}

const writeHolder = async (file: string, h: SyncLockHolder): Promise<void> => {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(h) + "\n", "utf8");
  await fs.rename(tmp, file);
};

/**
 * Run `work` holding the sync lock of `source` in the workspace at `root`. Throws `SyncLockedError`
 * when a live process holds it; nothing in `work` runs then. The heartbeat is refreshed every
 * `heartbeatMs` while `work` runs, and the lock is released however `work` ends.
 */
export async function withSyncLock<T>(root: string, source: string, work: () => Promise<T>, opts: SyncLockOptions = {}): Promise<T> {
  const file = syncLockPath(root, source);
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  const now = new Date().toISOString();
  const mine: SyncLockHolder = {
    pid: process.pid,
    machine: os.hostname(),
    since: now,
    heartbeat: now,
    token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
  };
  await withLock(file, async () => {
    const held = await readHolder(file);
    if (held) {
      const why = staleBecause(held, staleAfterMs);
      if (!why) throw new SyncLockedError(source, held);
      opts.onTakeover?.(`took over the ${source} sync lock from pid ${held.pid} on ${held.machine}: ${why}`);
    }
    await writeHolder(file, mine);
  });

  const beat = setInterval(() => {
    void withLock(file, async () => {
      const held = await readHolder(file);
      if (held?.token !== mine.token) return; // taken over: never write over the new holder
      await writeHolder(file, { ...mine, heartbeat: new Date().toISOString() });
    }).catch(() => {}); // a missed beat is retried on the next tick
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref?.();

  try {
    return await work();
  } finally {
    clearInterval(beat);
    await withLock(file, async () => {
      if ((await readHolder(file))?.token === mine.token) await fs.rm(file, { force: true });
    }).catch(() => {});
  }
}
