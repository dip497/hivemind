/**
 * The window's notification preferences: the `notifications` section of the settings mirror
 * (settings-store.ts), so a change made in another window or with `hive notifications set`
 * reaches every gate here at once. Reads are synchronous: the status bus fires on every agent
 * tick, and its in-app toast gate cannot wait.
 */
import { getSettings, patchSettings, subscribeSettings, useSettings } from "./settings-store";
import type { NotificationSettings } from "../../shared/notification-settings.js";

export function getNotificationSettings(): NotificationSettings {
  return getSettings().notifications;
}

/** The preferences, live, for a React component. */
export function useNotificationSettings(): NotificationSettings {
  return useSettings().notifications;
}

/** Store the whole section; the mirror shows it at once. */
export function saveNotificationSettings(s: NotificationSettings): void {
  patchSettings("notifications", s);
}

export { subscribeSettings as subscribeNotificationSettings };
