/**
 * Renderer-side cache of the notification preferences. The persisted blob lives
 * in main (settings.json); main answers `getNotificationSettings` over IPC and
 * we hold a snapshot here so the per-event in-app-toast gate in
 * useAgentAwareness is a cheap synchronous read (the status bus fires on every
 * agent tick — we can't await there).
 *
 * App.tsx loads the snapshot once on mount; the SettingsModal writes through
 * `save()` (which both persists via IPC and refreshes this cache) so a toggle
 * takes effect immediately, with no relaunch.
 */
import { DEFAULT_NOTIFICATION_SETTINGS, normalizeNotificationSettings, type NotificationSettings } from "../../shared/notification-settings.js";

let cache: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };
const listeners = new Set<(s: NotificationSettings) => void>();

/** Current cached settings (never null; defaults until the first IPC load). */
export function getNotificationSettings(): NotificationSettings {
  return cache;
}

/** Replace the cache (from an IPC load or a local write). Notifies subscribers. */
export function setNotificationSettingsCache(s: NotificationSettings | unknown): void {
  cache = normalizeNotificationSettings(s);
  for (const l of listeners) l(cache);
}

/** Subscribe to settings changes (SettingsModal uses this to stay live). */
export function subscribeNotificationSettings(l: (s: NotificationSettings) => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Persist a new snapshot + refresh the cache. Returns the normalized result. */
export async function saveNotificationSettings(s: NotificationSettings): Promise<NotificationSettings> {
  await window.hive.setNotificationSettings(s);
  setNotificationSettingsCache(s);
  return cache;
}
