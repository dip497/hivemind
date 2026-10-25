/**
 * The window's notification preferences: the `notifications` section of the settings mirror
 * (settings-store.ts), so a change made in another window or with `hive notifications set`
 * reaches every gate here at once. Reads are synchronous: the status bus fires on every agent
 * tick, and its in-app toast gate cannot wait.
 */
import { getSettings, patchSettings, useSettings } from "./settings-store";
import type { NotificationSettings } from "../../shared/notification-settings.js";

export function getNotificationSettings(): NotificationSettings {
  return getSettings().notifications;
}

/** The preferences, live, for a React component. */
export function useNotificationSettings(): NotificationSettings {
  return useSettings().notifications;
}

/** Store one setting by its dotted key in the section (`sounds.done`, `dnd.start`); the mirror
 *  shows it at once. Only that one is written, so a change made meanwhile to another (in another
 *  window, or with `hive notifications set`) stays. */
export function setNotificationSetting(key: string, value: boolean | number | string): void {
  patchSettings(`notifications.${key}`, value);
}
