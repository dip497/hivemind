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
 * `<file>.lock` created with O_EXCL (cross-process) plus an in-process promise
 * chain (same-process writers queue instead of interleaving). Callers pass a
 * mutation, never a snapshot — `patchSettingsFile` is the dotted-path form.
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

/** Atomic write: temp file in the same dir, then rename. Top-level keys the
 *  schema does not know (the app's pre-2.0 `browserCdp` flag lives in the same
 *  file) are carried over, so writing the theme never drops them. */
export async function writeSettings(next: Settings, file: string = settingsPath()): Promise<void> {
  await withLock(file, async () => writeBoth(mergeSettings(next), await unknownKeys(file), file));
}

/** The actual atomic write: schema settings + the file's non-schema top-level
 *  keys (`browserCdp`, `notifications`, …), which the app has always kept in the
 *  same file. Callers that CHANGED the extras pass their new value — re-reading
 *  them here would drop the change they just made. */
async function writeBoth(settings: Settings, extras: Record<string, unknown>, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...extras, ...settings }, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

/** Top-level keys of the file that are not part of `Settings`. */
async function unknownKeys(file: string): Promise<Record<string, unknown>> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const known = new Set(Object.keys(DEFAULT_SETTINGS));
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([k]) => !known.has(k)));
  } catch { return {}; }
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
  constructor(readonly lockFile: string) {
    super(
      `settings.json is locked by another writer (${lockFile}). Nothing was written. ` +
      `If no app or hive command is running, delete that file to recover.`,
    );
    this.name = "SettingsLockError";
  }
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
 * Take the lock, or fail. We never delete a lock we did not create: a lock file
 * that exists means SOMEONE may be mid-write, and there is no way to tell a
 * stuck holder from a busy one. A holder that crashed leaves the file behind —
 * that is recovered explicitly (`breakSettingsLock`, or deleting the file the
 * error names), never silently by a competing writer.
 */
async function acquire(lock: string): Promise<string> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = owner();
  for (;;) {
    try {
      const fh = await fs.open(lock, "wx");
      await fh.writeFile(token);
      await fh.close();
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() >= deadline) throw new SettingsLockError(lock);
      await sleep(LOCK_POLL_MS);
    }
  }
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
 * overwritten by a stale snapshot. Returns the settings as written.
 */
export async function updateSettings(
  mutate: (current: Settings) => Settings,
  file: string = settingsPath(),
): Promise<Settings> {
  return withLock(file, async () => {
    const next = mergeSettings(mutate(await readSettings(file)));
    await writeBoth(next, await unknownKeys(file), file);
    return next;
  });
}

/**
 * Patch the file's NON-schema top-level keys — the app's own legacy blobs
 * (`browserCdp`, `notifications`) that have always lived in settings.json and
 * are the same file as the theme in a packaged app. They used to be written
 * with a plain read-then-write, which erases whatever the theme wrote in
 * between; this applies them to the file as it is, under the same lock, and
 * carries the schema settings through untouched. A key set to `undefined` is
 * removed. Returns the extras as written.
 */
export async function patchSettingsExtras(
  patch: Record<string, unknown>,
  file: string = settingsPath(),
): Promise<Record<string, unknown>> {
  const known = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const key of Object.keys(patch)) {
    if (known.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`not an extra settings key: ${key}`);
    }
  }
  return withLock(file, async () => {
    const extras = { ...(await unknownKeys(file)) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete extras[k];
      else extras[k] = v;
    }
    await writeBoth(await readSettings(file), extras, file);
    return extras;
  });
}

/** Queue + lock + release, shared by every mutator. */
function withLock<T>(file: string, work: () => Promise<T>): Promise<T> {
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
  return updateSettings((cur) => patches.reduce((acc, p) => setPath(acc, p.path, p.value) as Settings, cur), file);
}
