/**
 * Main-side notification-settings store. The persisted blob lives in main's
 * settings.json (next to browserCdp etc.); this module owns the read + the
 * in-memory cache so the per-notice gate in agent-notify.ts is a cheap sync
 * read instead of a filesystem hit on every agent transition. Re-loaded on
 * every setNotificationSettings IPC so the renderer toggle takes effect live.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
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

/** Persist + refresh the cache. Renderer writes flow through here. */
export function setNotificationSettings(s: NotificationSettings): void {
  cache = normalizeNotificationSettings(s);
  const cur = readAll();
  cur.notifications = cache;
  writeFileSync(file(), JSON.stringify(cur, null, 2));
}

export { DEFAULT_NOTIFICATION_SETTINGS };
