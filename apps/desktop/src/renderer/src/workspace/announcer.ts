/**
 * What a screen reader is told about tiles: "<name> needs you", "<name> finished", "<name> failed",
 * once for each time a tile comes to that state. Statuses change many times a second, so this
 * keeps one look per tile and acts only when it changes; a state that has passed again before the
 * next announcement (a prompt answered at once, a turn that resumes) is never said.
 */
import type { StatusEvent } from "../agent-status-bus";
import { exitFailed, LOOKS, statusLook, type StatusLook } from "./status-look";

/** How long a new state waits before it is said, with any others that came meanwhile. */
const ANNOUNCE_MS = 700;

export function createAnnouncer(say: (text: string) => void): { onStatus: (e: StatusEvent) => void; stop: () => void } {
  const last = new Map<string, StatusLook>();
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending.size) say([...pending.values()].join(". "));
    pending.clear();
  };
  return {
    onStatus(e) {
      const look = statusLook(e.status, { failed: exitFailed(e) });
      const prev = last.get(e.tileId);
      last.set(e.tileId, look);
      // The first status seen of a tile (every live one when the window opens) is where it is, not news.
      if (prev === undefined || prev === look) return;
      const finished = prev === "working" && (look === "idle" || look === "exited") && !e.synthetic;
      const said = look === "needs" || look === "failed" ? LOOKS[look].word : finished ? LOOKS.done.word : null;
      const name = e.label.startsWith("tile-") ? "A tile" : e.label;
      if (said) pending.set(e.tileId, `${name} ${said}`);
      else pending.delete(e.tileId);
      if (pending.size && !timer) timer = setTimeout(flush, ANNOUNCE_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
