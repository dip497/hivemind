import { useEffect, useRef } from "react";
import { subscribeStatus } from "../agent-status-bus";
import { createAnnouncer } from "./announcer";

/** The window's one polite live region: a screen reader hears a tile that needs you, finished or
 *  failed (announcer.ts). Mounted once, by App; nothing is drawn. */
export function StatusAnnouncer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A new node each time, so the same words twice are still read twice.
    const a = createAnnouncer((text) => { const span = document.createElement("span"); span.textContent = text; ref.current?.replaceChildren(span); });
    const off = subscribeStatus(a.onStatus);
    return () => { off(); a.stop(); };
  }, []);
  return <div ref={ref} aria-live="polite" aria-atomic="true" className="sr-only" data-status-announcer />;
}
