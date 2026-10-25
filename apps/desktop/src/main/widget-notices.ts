/**
 * Which widget notices show, and when. A widget's `hive.notify` comes from the window that runs its
 * code and is decided here, against the notification settings main keeps: every window's change
 * lands here first, while a window's own copy can be older, or not loaded yet at start-up. Each
 * widget's last notice is kept here too, whichever window runs it.
 *
 * A widget shows at most one notice in WIDGET_NOTICE_GAP_MS. What it sends inside that time is held,
 * not dropped: when the time is up it shows once, its latest text and how many more came ("and 2
 * more"), if the settings still allow a notice then. One timer, for the widget whose time is up
 * first, and none while nothing is held. The gap is timed on the clock the timer runs on
 * (`performance.now()`), so setting the wall clock back or forward neither holds a notice longer
 * nor lets one through sooner; the wall clock only decides Do Not Disturb. Electron-free, so it is
 * tested as is; agent-notify.ts passes what shows a notice.
 */
import type { WidgetNotice } from "../shared/ipc.js";
import { WIDGET_NOTICE_GAP_MS, widgetNoticeAllowed, widgetNoticeBody, widgetNoticeText } from "../shared/notification-settings.js";
import { getNotificationSettings } from "./notification-settings-store.js";

export interface ShownWidgetNotice { title: string; body: string }

/** What decides widgets' notices: give it each `notify:widget` message, and it calls `show` with
 *  every notice that shows, at once or when the widget's time is up. */
export function widgetNotices(show: (n: ShownWidgetNotice) => void): (raw: unknown) => void {
  /** When each widget last showed a notice (`performance.now()`), by workspace and widget. */
  const shownAt = new Map<string, number>();
  /** What each widget sent since then, inside the gap: its latest title and text, and how many. */
  const held = new Map<string, { title: string; text: string; count: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;

  const allowed = () => widgetNoticeAllowed(getNotificationSettings(), Date.now());
  /** When a widget may show again. */
  const dueAt = (key: string) => (shownAt.get(key) ?? -Infinity) + WIDGET_NOTICE_GAP_MS;

  function showNow(key: string, title: string, text: string, more: number, now: number): void {
    shownAt.set(key, now);
    show({ title, body: widgetNoticeBody(text, more) });
  }

  /** Wake at `at` unless an earlier wake is set. */
  function wakeAt(at: number, now: number): void {
    if (timer && timerAt <= at) return;
    if (timer) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(flush, Math.max(0, at - now));
  }

  /** Show each held widget whose time is up (or drop it, if the settings allow no notice now), then
   *  wake for the next. */
  function flush(): void {
    timer = null;
    timerAt = Infinity;
    const now = performance.now();
    let next = Infinity;
    for (const [key, h] of held) {
      const due = dueAt(key);
      if (due > now) { next = Math.min(next, due); continue; }
      held.delete(key);
      if (allowed()) showNow(key, h.title, h.text, h.count - 1, now);
    }
    if (next !== Infinity) wakeAt(next, now);
  }

  return (raw) => {
    const n = raw as Partial<WidgetNotice> | null;
    if (typeof n?.repo !== "string" || typeof n.widget !== "string") return;
    if (!allowed()) return;
    const now = performance.now();
    const key = `${n.repo}\n${n.widget}`;
    const title = typeof n.title === "string" && n.title.trim() ? n.title.trim().slice(0, 64) : "Widget";
    const text = widgetNoticeText(n.text);
    if (now < dueAt(key)) {
      held.set(key, { title, text, count: (held.get(key)?.count ?? 0) + 1 });
      wakeAt(dueAt(key), now);
      return;
    }
    // One shown longer ago than the gap holds nothing back any more, unless it still holds some.
    for (const [k, at] of shownAt) if (now - at >= WIDGET_NOTICE_GAP_MS && !held.has(k)) shownAt.delete(k);
    // Its time is up but the timer has not run yet: what it held comes with this one.
    const waiting = held.get(key)?.count ?? 0;
    held.delete(key);
    showNow(key, title, text, waiting, now);
  };
}
