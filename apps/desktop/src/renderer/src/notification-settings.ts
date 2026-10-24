/**
 * The window's notification preferences: the `notifications` section of the settings mirror
 * (settings-store.ts), so a change made in another window or with `hive notifications set`
 * reaches every gate here at once. Reads are synchronous: the status bus fires on every agent
 * tick, and its in-app toast gate cannot wait.
 */
import { getSettings, patchSettingsMany, subscribeSettings, useSettings } from "./settings-store";
import type { NotificationSettings } from "../../shared/notification-settings.js";

export function getNotificationSettings(): NotificationSettings {
  return getSettings().notifications;
}

/** The preferences, live, for a React component. */
export function useNotificationSettings(): NotificationSettings {
  return useSettings().notifications;
}

/** Store what changed, each value at its own path (`notifications.dnd.start`), so the section's
 *  other values, and keys a newer build keeps in it, stay as the file has them. The mirror shows
 *  it at once. */
export function saveNotificationSettings(patch: Partial<NotificationSettings>): void {
  patchSettingsMany(Object.entries(patch).flatMap(([k, v]): { path: string; value: unknown }[] => (v && typeof v === "object"
    ? Object.entries(v).map(([kk, vv]) => ({ path: `notifications.${k}.${kk}`, value: vv }))
    : [{ path: `notifications.${k}`, value: v }])));
}

export { subscribeSettings as subscribeNotificationSettings };
