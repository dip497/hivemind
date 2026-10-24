/**
 * The OS pop-up half of the notice desk (notice-desk.ts decides when; agent-notify-core.ts what
 * it says), and a widget's `hive.notify` (decided in widget-notices.ts).
 *
 * The desk shows a pop-up only while no app window has the focus: a window that has it already
 * shows the toast. backgroundThrottling:false (index.ts) keeps every window's status bus running
 * while unfocused, so changes still reach the desk when the person is away.
 */
import { Notification, app, type BrowserWindow } from "electron";
import { on } from "./app-ipc.js";
import type { AgentNotice } from "../shared/ipc.js";
import { composeGroup, composeNotice, withText } from "./agent-notify-core.js";
import { widgetNoticeToShow } from "./widget-notices.js";

/** Show one pop-up: one agent (`more` false) with its `text` when given, or a gathered group.
 *  `silent` when the app plays its own sound for it. Its click brings `win()` forward on the first
 *  agent's tile. */
export function showAgentPopup(p: { kind: AgentNotice["kind"]; notices: AgentNotice[]; more: boolean; silent: boolean }, text: string | undefined, win: () => BrowserWindow | null): void {
  if (!Notification.isSupported()) return;
  const first = p.notices[0];
  if (!first) return;
  const composed = p.more ? composeGroup(p.kind, p.notices) : composeNotice(first);
  if (!composed) return;
  const n = new Notification({ ...withText(composed, p.more ? undefined : text), silent: p.silent });
  n.on("click", () => {
    const w = win();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    try { w.webContents.send("notify:focus-tile", first.tileId); } catch { /* mid-teardown */ }
  });
  // macOS shows notifications only for a code-signed app; unsigned, the dock bounce below
  // is what remains, and the log says why the banner did not appear.
  n.on("failed", (_e, error) => console.warn("[notify] the OS did not show it:", error));
  n.show();
  // Persistent attention until the person looks (cleared on window 'focus').
  try { win()?.flashFrame(true); } catch { /* unsupported DE */ }
  try { app.dock?.bounce?.(composed.urgency === "critical" ? "critical" : "informational"); } catch { /* macOS only */ }
}

/** Register `notify:widget`: a widget's `hive.notify`, from the window that runs it, shown as an
 *  OS notice when `widgetNoticeToShow` says so. */
export function registerWidgetNotifications(): void {
  on("notify:widget", (_e: unknown, raw: unknown) => {
    if (!Notification.isSupported()) return;
    const shown = widgetNoticeToShow(raw, Date.now());
    if (!shown) return;
    const n = new Notification(shown);
    n.on("failed", (_e, error) => console.warn("[notify] the OS did not show a widget's notice:", error));
    n.show();
  }, { local: true });
}
