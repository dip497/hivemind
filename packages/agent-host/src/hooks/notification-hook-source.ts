/**
 * The `Notification` hook source — emitted to disk as `hcp-notification-hook.cjs`,
 * run by `claude` when it raises a desktop notification ("Claude needs your
 * permission", "Claude is waiting for your input", …). It forwards the
 * notification_type to the HCP socket so main can set a deterministic "needs you"
 * status on the tile — hardening the screen-scrape and surviving UI-string
 * changes. The status→kind mapping + auto-clear live in main/the renderer (see
 * hcp/notification-map.ts); this hook just relays the raw type.
 *
 * Built on the shared {@link eventHookSource} skeleton. The Notification payload
 * is `{ message, title, notification_type }`.
 */
import { eventHookSource } from "./event-hook-source.js";

export function notificationHookSource(): string {
  return eventHookSource(
    "notification",
    `var nt = (evt && (evt.notification_type || evt.notificationType)) || "";
     return { tileId: tileId, notificationType: String(nt), message: (evt && evt.message) || "" };`,
  );
}
