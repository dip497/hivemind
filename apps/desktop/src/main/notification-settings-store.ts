/**
 * Main's notification preferences: the `notifications` section of the one settings.json, read
 * and written through its owner (settings-store.ts). The notice desk reads them on every agent
 * change, so this is the owner's in-memory snapshot, never a file read; a `hive notifications set`
 * reaches it through `settings.reload`, which replaces that snapshot.
 */
import { getSettings } from "./settings-store.js";
import type { NotificationSettings } from "../shared/notification-settings.js";

/** The preferences now. Never throws. */
export function getNotificationSettings(): NotificationSettings {
  return getSettings().notifications;
}
