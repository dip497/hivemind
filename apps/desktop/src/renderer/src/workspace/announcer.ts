/**
 * What a screen reader is told about tiles: a tile's name and "needs you", "finished" or "failed",
 * for the same changes a toast and an OS notification tell (useAgentAwareness's `noticeOf`), under
 * the same notification settings. Unlike a toast it is said for the selected tile too: a screen
 * reader does not see the tile change. Each is said once its tile's state has held for a moment, so
 * a state that passes at once (a prompt answered, a turn that resumes) is never said. It is timed on
 * the clock the timers run on (`performance.now()`): the wall clock set back would hold it back as long.
 *
 * Per status event: a map read and write and the notice check, all O(1). The bus emits only on a
 * change. The timer runs only while something waits to be said. A flush, at most once per notice
 * queued, walks every tile seen so far to drop the closed ones: O(live tiles), a map read each.
 */
import { statusOf, type StatusEvent, type TileStatusKind } from "../agent-status-bus";
import { noticeOf, type NoticeKind } from "../useAgentAwareness";
import { getNotificationSettings } from "../notification-settings";
import { shouldNotify } from "../../../shared/notification-settings.js";
import { LOOKS } from "./status-look";

/** How long a tile's new state holds before it is said. */
const ANNOUNCE_MS = 700;

const WORD: Record<NoticeKind, string> = { needs: LOOKS.needs.word, done: LOOKS.done.word, error: LOOKS.failed.word };

export function createAnnouncer(say: (text: string) => void): { onStatus: (e: StatusEvent) => void; stop: () => void } {
  /** Each tile's last status, to tell a change from a repeat. */
  const last = new Map<string, TileStatusKind>();
  /** What waits to be said, per tile, and when its state changed (`performance.now()`). */
  const pending = new Map<string, { text: string; at: number }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer || !pending.size) return;
    const first = Math.min(...[...pending.values()].map((p) => p.at));
    timer = setTimeout(flush, Math.max(0, first + ANNOUNCE_MS - performance.now()));
  };
  const flush = () => {
    timer = null;
    const now = performance.now();
    // A tile the bus no longer knows has closed: nothing of it is said or kept.
    for (const id of last.keys()) if (statusOf(id) === null) { last.delete(id); pending.delete(id); }
    const due: string[] = [];
    for (const [id, p] of pending) if (now - p.at >= ANNOUNCE_MS) { due.push(p.text); pending.delete(id); }
    if (due.length) say(due.join(". "));
    arm();
  };
  return {
    onStatus(e) {
      const prev = last.get(e.tileId);
      if (prev === e.status) return;
      last.set(e.tileId, e.status);
      const kind = noticeOf(prev, e);
      if (kind && shouldNotify(getNotificationSettings(), kind, "inApp")) {
        const name = e.label.startsWith("tile-") ? "A tile" : e.label;
        pending.set(e.tileId, { text: `${name} ${WORD[kind]}`, at: performance.now() });
      } else pending.delete(e.tileId);
      arm();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
