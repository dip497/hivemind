/**
 * Notification preferences for the app's two processes: the shape, the normalizer and the
 * decisions live in @hivemind/core (the `notifications` key of settings.json, which the `hive` CLI
 * reads too); a widget's notices are the app's own and stay here.
 */
import { dndActive, type NotificationSettings } from "@hivemind/core/notification-settings";

export * from "@hivemind/core/notification-settings";

/** A widget's notices: at most one per widget in this long, each at most this many characters. */
export const WIDGET_NOTICE_GAP_MS = 10_000;
const WIDGET_NOTICE_MAX = 200;
/** The most of a notice's text (UTF-16 units) a window sends main and main reads: enough for
 *  WIDGET_NOTICE_MAX characters, however many units each takes. */
export const WIDGET_NOTICE_SENT_MAX = WIDGET_NOTICE_MAX * 2;

/** A widget's `hive.notify`: the text to show as an OS pop-up now, or null. It follows the master
 *  switch, the pop-up switch and Do Not Disturb (a widget is never urgent), and stays quiet within
 *  WIDGET_NOTICE_GAP_MS of that widget's last notice (`last`). The text is cut to WIDGET_NOTICE_MAX. */
export function widgetNotice(s: NotificationSettings, text: unknown, last: number | undefined, now: number): string | null {
  if (!s.enabled || !s.osPopups || dndActive(s, now)) return null;
  if (last !== undefined && now - last < WIDGET_NOTICE_GAP_MS) return null;
  const chars = [...String(text ?? "").slice(0, WIDGET_NOTICE_SENT_MAX)];
  return chars.length > WIDGET_NOTICE_MAX ? `${chars.slice(0, WIDGET_NOTICE_MAX - 1).join("")}…` : chars.join("");
}
