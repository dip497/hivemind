/**
 * Main-side notification-settings store. The persisted blob lives in main's
 * settings.json (next to browserCdp etc.); this module owns the read + the
 * in-memory cache so the per-notice gate in agent-notify.ts is a cheap sync
 * read instead of a filesystem hit on every agent transition. Re-loaded on
 * every setNotificationSettings IPC so the renderer toggle takes effect live.
 *
 * The blob shares settings.json with the user's theme (the same file in a
 * packaged app), so the WRITE goes through the shared lock in
 * @hivemind/core/settings — a plain read-then-write here would erase whatever
 * the theme wrote between this module's read and its write. The read stays a
 * cheap sync read: reads never lose data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { patchSettingsExtras } from "@hivemind/core/settings";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeNotificationSettings,
  type NotificationSettings,
} from "../shared/notification-settings.js";

let cache: NotificationSettings | null = null;

function file(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** Read the full settings.json blob (best-effort; {} on any parse/IO failure). */
function readAll(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

/** Current notification settings (normalized onto defaults; cached after first
 *  read). Call from either process-side gate; never throws. */
export function getNotificationSettings(): NotificationSettings {
  if (cache) return cache;
  const raw = readAll().notifications;
  cache = normalizeNotificationSettings(raw);
  return cache;
}

/** Persist + refresh the cache. Renderer writes flow through here. The cache is
 *  updated synchronously so the notification gate sees the new value at once;
 *  the file write is awaited by the caller. */
export async function setNotificationSettings(s: NotificationSettings): Promise<void> {
  cache = normalizeNotificationSettings(s);
  await patchSettingsExtras({ notifications: cache }, file());
}

export { DEFAULT_NOTIFICATION_SETTINGS };
