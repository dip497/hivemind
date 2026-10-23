/**
 * Main's notification preferences: the `notifications` section of the one settings.json, read
 * and written through its owner (settings-store.ts). The notice desk reads them on every agent
 * change, so this is the owner's in-memory snapshot, never a file read; a `hive notifications set`
 * reaches it through `settings.reload`, which replaces that snapshot.
 */
import { getSettings, patchSettings } from "./settings-store.js";
import { normalizeNotificationSettings, type NotificationSettings } from "../shared/notification-settings.js";

/** The preferences now. Never throws. */
export function getNotificationSettings(): NotificationSettings {
  return getSettings().notifications;
}

/** Store the window's preferences, whole, as one patch of the section. */
export async function setNotificationSettings(s: unknown): Promise<NotificationSettings> {
  return (await patchSettings([{ path: "notifications", value: normalizeNotificationSettings(s) }])).notifications;
}
