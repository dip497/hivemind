/**
 * The notification preferences, which the app kept in a settings.json of its own data folder
 * (`app.getPath("userData")`), move into the one settings.json the app and `hive` share, as its
 * `notifications` section. On macOS, Windows and in a dev run those are two files, so
 * `hive config get notifications` found nothing and the app never saw a change made there. On
 * Linux they are one file, and nothing moves.
 *
 * The data folder's file is backed up, only when it holds a blob to move: on Linux, or once moved,
 * there is no backup, so restoring 0006 never puts back a settings.json older than changes made
 * since. The one settings.json only gains the section, and only when it has none, or one that
 * reads as the defaults (a build that wrote whole sections stored them, so a write made while an
 * older app held this migration back stored the defaults, not a choice). A section someone
 * changed wins. The old blob is written whole, as this build reads it: each of its values set
 * even where it equals the default, so the section in the file says what the person chose, not
 * what this build happens to default to. (Only an app older than this migration wrote that blob,
 * so it holds no key this build does not read.) Run again after being cut off, it finds the
 * section moved and only takes the old blob out.
 *
 * Number 0005 is skipped: a 0005 lived on a branch and was dropped before any release, and a
 * ledger that ran it keeps that id.
 */
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { settingsPath, updateSettings, withLock } from "../settings.js";
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings } from "../notification-settings.js";
import type { Migration } from "./runner.js";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** One path for a file, symlinks followed, whether or not it exists yet. */
async function samePath(a: string, b: string): Promise<boolean> {
  const real = async (p: string) => {
    const dir = await realpath(path.dirname(p)).catch(() => path.resolve(path.dirname(p)));
    return path.join(dir, path.basename(p));
  };
  return (await real(a)) === (await real(b));
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, "utf8"));
    return isObj(raw) ? raw : null;
  } catch { return null; }
}

export const m0006: Migration = {
  id: "0006-notifications-into-settings",
  root: "data",
  backsUp: ["settings.json"],
  // An older app still running reads and writes its notifications in the old file.
  movesFilesAnOlderAppReads: true,
  async changesHere(ctx) {
    const from = path.join(ctx.root, "settings.json");
    return !(await samePath(from, settingsPath())) && "notifications" in ((await readJson(from)) ?? {});
  },
  async run(ctx) {
    const from = path.join(ctx.root, "settings.json");
    const to = settingsPath();
    if (await samePath(from, to)) return { moved: false, why: "one file" };
    const old = await readJson(from);
    if (!old || !("notifications" in old)) return { moved: false, why: "nothing to move" };
    const there = (await readJson(to))?.notifications;
    const kept = isObj(there) && JSON.stringify(normalizeNotificationSettings(there)) !== JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS);
    if (!kept) {
      await updateSettings((cur) => ({ ...cur, notifications: normalizeNotificationSettings(old.notifications) }), to, ["notifications"]);
    }
    // The old blob goes, so nothing reads a second copy; the rest of that file (its `browserCdp`)
    // stays as it is.
    await withLock(from, async () => {
      const now = await readJson(from);
      if (!now || !("notifications" in now)) return;
      const { notifications: _gone, ...rest } = now;
      const tmp = `${from}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(rest, null, 2) + "\n", "utf8");
      await rename(tmp, from);
    });
    return { moved: !kept, kept };
  },
};
