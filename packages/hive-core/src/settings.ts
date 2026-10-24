/**
 * settings.json on disk (node side): where it lives, atomic read/write. Main
 * owns the file while the app runs; the `hive` CLI edits it too and asks a
 * running app to reload over HCP (`settings.reload`).
 *
 *   $HIVE_SETTINGS                       explicit path (the e2e suite, a dev profile)
 *   $XDG_CONFIG_HOME/hivemind/settings.json   default — the app's userData dir
 *
 * CONCURRENCY. Three writers share this file: the app's main process, a `hive
 * config|theme` CLI run, and (through main) the renderer. A plain
 * read-modify-write loses updates — a writer that read the file a moment ago
 * writes back a snapshot that predates someone else's change, silently
 * reverting it. Every mutation therefore goes through `updateSettings`, which
 * re-reads the file INSIDE a lock it holds across the read and the write:
 * `<file>.lock`, which appears with its owner's token already in it (see
 * `createLock`), plus an in-process promise chain (same-process writers queue
 * instead of interleaving). Callers pass a mutation, never a snapshot —
 * `patchSettingsFile` is the dotted-path form.
 *
 * WHAT A WRITE KEEPS. A write applies only what it changed onto the file's own JSON
 * (`writtenOnto`, settings-write.ts); normalising happens on read. So a key or value
 * this build does not read — a newer build's, anywhere in the file — survives it,
 * and the file's `v` is never lowered.
 *
 * The lock is OWNERSHIP-SAFE: each acquisition writes a unique token and only
 * ever deletes a lock carrying that token, and a writer that cannot take the
 * lock within `LOCK_WAIT_MS` FAILS (`SettingsLockError`) instead of removing
 * someone else's. Age does not prove death — a slow holder and a dead one look
 * identical — so a lock left by a crashed writer is cleared explicitly, by a
 * human or by `breakSettingsLock`, never by a competing writer.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_SETTINGS, mergeSettings, setPath, type Settings } from "./settings-schema.js";
import { assign, writtenOnto, type Touched } from "./settings-write.js";

export function settingsPath(): string {
  if (process.env.HIVE_SETTINGS?.trim()) return path.resolve(process.env.HIVE_SETTINGS.trim());
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "settings.json");
}

/** Read + validate; a missing or corrupt file is the defaults. */
export async function readSettings(file: string = settingsPath()): Promise<Settings> {
  try { return mergeSettings(JSON.parse(await fs.readFile(file, "utf8"))); }
  catch { return mergeSettings(DEFAULT_SETTINGS); }
}

/** The file's JSON as it is, or undefined when it is missing or not JSON. */
async function readRaw(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return undefined; }
}

/** Atomic write: temp file in the same dir, then rename. */
async function writeRaw(json: Record<string, unknown>, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(json, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

// ── serialized read/modify/write ────────────────────────────────────────────

/** How long a writer waits for someone else's lock before giving up. A write is
 *  a few ms of I/O, so this is orders of magnitude more than honest contention;
 *  reaching it means a real holder is stuck (or died without releasing). */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Failure to take the lock. The write did NOT happen — nothing was read,
 *  nothing was written, and no other writer's lock was disturbed. */
export class SettingsLockError extends Error {
  readonly code = "settings_locked";
  constructor(readonly lockFile: string, holder?: { pid: number; heldForMs: number }) {
    // Name the holder: "locked by another writer" sends someone hunting for a writer that,
    // more often than not, is a file a crashed one left behind.
    const who = holder
      ? `held by pid ${holder.pid} for ${Math.round(holder.heldForMs / 1000)}s` +
        (isAlive(holder.pid) ? "" : " — that process is gone, so the lock is stale")
      : "the holder could not be read";
    super(
      `settings.json is locked by another writer (${lockFile}; ${who}). Nothing was written. ` +
      `If no app or hive command is running, delete that file to recover.`,
    );
    this.name = "SettingsLockError";
  }
}

/** Is that process still there? Signal 0 checks without touching it. */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** In-process queue: same-process writers never race each other, and they hold
 *  the file lock one at a time. Chained regardless of outcome. */
let queue: Promise<unknown> = Promise.resolve();

/** Unique per acquisition, so a release can prove the lock it deletes is ITS
 *  own. Age can never prove that: a slow-but-live holder looks exactly like a
 *  dead one, and deleting on age lets writer A remove writer B's fresh lock and
 *  then two writers edit the file at once — the very thing the lock prevents. */
const owner = () => `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

/**
 * Take the lock, or fail. A lock we did not create is never deleted on age: a slow-but-live
 * holder looks exactly like a dead one, and deleting on age lets two writers edit the file
 * at once — the thing the lock exists to prevent.
 *
 * A holder that is *gone*, though, is not a judgement call. The lock records the pid that
 * took it, and a process that no longer exists cannot be mid-write, so its lock is cleared
 * after a grace period (long enough that a pid freshly reused by an unrelated process is
 * not mistaken for the holder) and the acquisition retried once. Without this, an app that
 * was killed mid-write leaves a file that every later `hive` command refuses to write past
 * until someone deletes it by hand.
 */
async function acquire(lock: string, waitMs = LOCK_WAIT_MS, onWaiting?: () => void): Promise<string> {
  const deadline = Date.now() + waitMs;
  const token = owner();
  let broke = false;
  let told = false;
  for (;;) {
    if (await createLock(lock, token)) return token;
    if (!broke && await isStale(lock)) { broke = await clearStale(lock); continue; }
    if (!told) { told = true; onWaiting?.(); }
    if (Date.now() >= deadline) {
      let holder: { pid: number; heldForMs: number } | undefined;
      try {
        const [pid, at] = (await fs.readFile(lock, "utf8")).trim().split(":");
        if (pid && at) holder = { pid: Number(pid), heldForMs: Date.now() - Number(at) };
      } catch { /* gone or unreadable: the message says so */ }
      throw new SettingsLockError(lock, holder);
    }
    await sleep(LOCK_POLL_MS);
  }
}

/** Errors from a filesystem that has no hard links (FAT, some network shares). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]);

/**
 * Create the lock with `token` already in it; false when someone else holds it. The token is
 * written to a private file first and a hard link publishes it under the lock's name, which
 * fails if the lock exists. So the lock is never there without its owner: a writer that dies
 * at any point leaves no lock, or one naming a process that is gone, which `isStale` clears.
 * Created empty and filled afterwards, a writer that died in between (an app quitting
 * mid-write) left a lock naming nobody, and such a lock is never broken: every later write
 * failed until someone deleted it by hand.
 */
async function createLock(lock: string, token: string): Promise<boolean> {
  const draft = `${lock}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await fs.writeFile(draft, token, { flag: "wx" });
    await fs.link(draft, lock);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (NO_HARD_LINKS.has(code)) return createLockInPlace(lock, token);
    throw e;
  } finally {
    await fs.rm(draft, { force: true }).catch(() => {});
  }
}

/** Without hard links: create the lock, then write the token into it. */
async function createLockInPlace(lock: string, token: string): Promise<boolean> {
  try {
    const fh = await fs.open(lock, "wx");
    try { await fh.writeFile(token); } finally { await fh.close(); }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/** How long a dead holder's lock is left alone, so a reused pid cannot be mistaken for it. */
const STALE_AFTER_MS = 2_000;

/** Was this lock taken by a process that no longer exists, a while ago? */
async function isStale(lock: string): Promise<boolean> {
  try {
    const [pid, at] = (await fs.readFile(lock, "utf8")).trim().split(":");
    const taken = Number(at);
    if (!pid || !Number.isFinite(taken)) return false;
    return Date.now() - taken > STALE_AFTER_MS && !isAlive(Number(pid));
  } catch { return false; }
}

/** Remove exactly the stale file we read, and say whether we did. */
async function clearStale(lock: string): Promise<boolean> {
  try {
    const before = (await fs.readFile(lock, "utf8")).trim();
    if (!(await isStale(lock))) return false; // it changed hands while we looked
    const now = (await fs.readFile(lock, "utf8")).trim();
    if (now !== before) return false;
    await fs.rm(lock, { force: true });
    return true;
  } catch { return false; }
}

/** Release only OUR lock. If the file holds someone else's token (ours was
 *  recovered by hand and the lock retaken meanwhile) it is left alone. */
async function release(lock: string, token: string): Promise<void> {
  try {
    if ((await fs.readFile(lock, "utf8")).trim() !== token) return;
    await fs.rm(lock, { force: true });
  } catch { /* already gone: nothing to release */ }
}

/**
 * Explicit stale-lock recovery, for a lock left by a writer that died. This is
 * deliberately a separate, caller-initiated act (a human deleting the file, or
 * a tool that has decided the holder is gone) — routine writers never do it.
 * Returns whether a lock file was removed.
 */
export async function breakSettingsLock(file: string = settingsPath()): Promise<boolean> {
  try { await fs.rm(`${file}.lock`); return true; } catch { return false; }
}

/**
 * Read the file, apply `mutate` to what is ACTUALLY on disk right now, write the
 * result — all while holding the lock, so a concurrent writer's change is never
 * overwritten by a stale snapshot. What the mutation changed is written onto the
 * file's own JSON (`writtenOnto`), and each `touched` dotted path is written as
 * `mutate` left it even where it reads the same (undefined removes the key, one
 * this build does not read too); `touched` may be worked out from the settings as read, under
 * the same lock (`presetPaths`). Returns the settings as the file now reads.
 */
export async function updateSettings(
  mutate: (current: Settings) => Settings,
  file: string = settingsPath(),
  touched: readonly Touched[] | ((current: Settings) => readonly Touched[]) = [],
): Promise<Settings> {
  return withLock(file, async () => {
    const raw = await readRaw(file);
    const cur = mergeSettings(raw);
    const json = writtenOnto(raw, cur, mergeSettings(mutate(cur)), typeof touched === "function" ? touched(cur) : touched);
    await writeRaw(json, file);
    return mergeSettings(json);
  });
}

/**
 * Patch the file's NON-schema top-level keys — the app's own legacy blobs
 * (`browserCdp`) that have always lived in settings.json and
 * are the same file as the theme in a packaged app. They used to be written
 * with a plain read-then-write, which erases whatever the theme wrote in
 * between; this applies them to the file as it is, under the same lock, and
 * carries the schema settings through untouched. A value is merged as the writer merges
 * (`assign`): an object value by value, keeping the keys the file has inside it; anything else
 * replaces; `undefined` removes the key. Returns the extras as written.
 */
export async function patchSettingsExtras(
  patch: Record<string, unknown>,
  file: string = settingsPath(),
): Promise<Record<string, unknown>> {
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const key of Object.keys(patch)) {
    if (known.has(key) || key === "__proto__") {
      throw new Error(`not an extra settings key: ${key}`);
    }
  }
  return withLock(file, async () => {
    const raw = await readRaw(file);
    const json = writtenOnto(raw, mergeSettings(raw), mergeSettings(raw));
    for (const [k, v] of Object.entries(patch)) assign(json, k, v);
    await writeRaw(json, file);
    return Object.fromEntries(Object.entries(json).filter(([k]) => !known.has(k)));
  });
}

/** Hold the lock file `lock` while `work` runs, waiting up to `waitMs` for another process's,
 *  without the in-process queue: for a job that itself writes files under `withLock`.
 *  `onWaiting` hears once that another holder is being waited for. */
export async function holdLock<T>(lock: string, work: () => Promise<T>, waitMs: number, onWaiting?: () => void): Promise<T> {
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const token = await acquire(lock, waitMs, onWaiting);
  try { return await work(); }
  finally { await release(lock, token); }
}

/** Queue + lock + release, shared by every mutator, and by any other file of the app's that
 *  more than one process writes (`<file>.lock`, the same rules). */
export function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const token = await acquire(lock); // throws SettingsLockError; nothing written
    try { return await work(); }
    finally { await release(lock, token); }
  });
  queue = run.catch(() => {});
  return run;
}

/** Dotted-path form: `[{ path: "appearance.glass.blur", value: 12 }]` applied to
 *  the file as it is on disk. This is what the app and the CLI send — a path
 *  patch carries only what the user changed, so two writers editing different
 *  settings both survive. */
export async function patchSettingsFile(
  patches: readonly { path: string; value: unknown }[],
  file: string = settingsPath(),
): Promise<Settings> {
  return updateSettings((cur) => patches.reduce((acc, p) => setPath(acc, p.path, p.value) as Settings, cur), file, patches.map((p) => p.path));
}
