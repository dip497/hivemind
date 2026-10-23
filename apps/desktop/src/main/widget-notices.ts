/**
 * Which widget notices show. A widget's `hive.notify` comes from the window that runs its code
 * and is decided here, against the notification settings main keeps: every window's change lands
 * here first, while a window's own copy can be older, or not loaded yet at start-up. Each widget's
 * last notice is kept here too, whichever window runs it. Electron-free, so it is tested as is;
 * agent-notify.ts shows what it returns.
 */
import type { WidgetNotice } from "../shared/ipc.js";
import { WIDGET_NOTICE_GAP_MS, widgetNotice } from "../shared/notification-settings.js";
import { getNotificationSettings } from "./notification-settings-store.js";

/** When each widget's last notice was shown, by workspace and widget. */
const shownAt = new Map<string, number>();

/** The notice to show for `raw` at `now`, or null: as `widgetNotice` allows under main's
 *  notification settings, titled with the widget's name. */
export function widgetNoticeToShow(raw: unknown, now: number): { title: string; body: string } | null {
  const n = raw as Partial<WidgetNotice> | null;
  if (typeof n?.repo !== "string" || typeof n.widget !== "string") return null;
  const key = `${n.repo}\n${n.widget}`;
  const body = widgetNotice(getNotificationSettings(), n.text, shownAt.get(key), now);
  if (body === null) return null;
  // One shown longer ago than the gap holds nothing back any more.
  for (const [k, at] of shownAt) if (now - at >= WIDGET_NOTICE_GAP_MS) shownAt.delete(k);
  shownAt.set(key, now);
  const title = typeof n.title === "string" && n.title.trim() ? n.title.trim().slice(0, 64) : "Widget";
  return { title, body };
}
