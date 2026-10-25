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

/** Whether a widget's `hive.notify` may show as an OS pop-up at `now`: it follows the master
 *  switch, the pop-up switch and Do Not Disturb (a widget is never urgent). */
export function widgetNoticeAllowed(s: NotificationSettings, now: number): boolean {
  return s.enabled && s.osPopups && !dndActive(s, now);
}

/** A widget's notice text as it shows: cut to WIDGET_NOTICE_MAX characters. */
export function widgetNoticeText(text: unknown): string {
  const chars = [...String(text ?? "").slice(0, WIDGET_NOTICE_SENT_MAX)];
  return chars.length > WIDGET_NOTICE_MAX ? `${chars.slice(0, WIDGET_NOTICE_MAX - 1).join("")}…` : chars.join("");
}

/** A notice's body: the widget's latest text and, on a line of its own, how many more it sent
 *  while it waited for its turn ("and 2 more"). */
export function widgetNoticeBody(text: string, more: number): string {
  return more > 0 ? `${text}\nand ${more} more` : text;
}
