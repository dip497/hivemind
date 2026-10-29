/** The Shoal wallpaper: fish and sharks drawn in characters behind the canvas, one shark per agent,
 *  in the theme's page and text colours. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { statusOf, subscribeStatus } from "../agent-status-bus";
import { cssColorToHex } from "../workspace/css-color";
import { ShoalEngine, type ShoalMode } from "./engine";
import { roster, turnEnded, type ShoalAgent } from "./roster";
import type { Box, SharkSpec } from "./world";

/** A media query as a store, for useSyncExternalStore. */
function mediaStore(query: string) {
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null;
  return {
    watch: (cb: () => void) => {
      mq?.addEventListener("change", cb);
      return () => mq?.removeEventListener("change", cb);
    },
    now: () => mq?.matches === true,
  };
}
const lessMotion = mediaStore("(prefers-reduced-motion: reduce)");
// The wallpaper layer is not shown at all for these (styles.css): nothing to draw.
const moreContrast = mediaStore("(prefers-contrast: more)");
const lessTransparency = mediaStore("(prefers-reduced-transparency: reduce)");

/** What the scene keeps out from under, and draws no shark under: the canvas's tiles (not its
 *  frames, which are zones the water shows through), and the Layers panel and the toolbars unless
 *  they are glass. A frosted panel shows a shark through it, softened, as it passes under; a tile
 *  stays solid, so its text never runs over one. */
const TILES = ".react-flow__node:not(.react-flow__node-frame)[data-id]";
const PANELS = 'aside[aria-label="Layers"], .hm-island';
function boxesOnPage(frosted: boolean): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(frosted ? TILES : `${TILES}, ${PANELS}`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, ...(el.dataset.id ? { key: el.dataset.id } : {}) });
  }
  return out;
}

const rosterKey = (sharks: SharkSpec[]) => sharks.map((s) => `${s.key}:${s.kind}:${s.size}:${s.mood}`).join("|");

export function Shoal({ agents, paused, animate, frosted, page, text, monoFont }: {
  /** The workspace's agents, the same array until one comes, goes or falls asleep. */
  agents: readonly ShoalAgent[];
  /** The window is hidden, unfocused or idle, or something covers the workspace. */
  paused: boolean;
  /** The person's Animation switch. */
  animate: boolean;
  /** Glass is on: the panels over the scene are frosted, and the sharks swim under them. */
  frosted: boolean;
  /** The theme's page and text colours (CSS). */
  page: string;
  text: string;
  /** The terminal's font, which the scene's characters take (read from the page; this says when). */
  monoFont: string;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ShoalEngine | null>(null);
  const reduced = useSyncExternalStore(lessMotion.watch, lessMotion.now, lessMotion.now);
  const contrast = useSyncExternalStore(moreContrast.watch, moreContrast.now, moreContrast.now);
  const solid = useSyncExternalStore(lessTransparency.watch, lessTransparency.now, lessTransparency.now);
  const shown = !contrast && !solid;
  const mode: ShoalMode = !animate || reduced ? "still" : paused ? "hold" : "run";

  useEffect(() => {
    if (!shown) return;
    const e = new ShoalEngine(hostRef.current!);
    setEngine(e);
    return () => { e.destroy(); setEngine(null); };
  }, [shown]);

  useEffect(() => { engine?.setColours(cssColorToHex(page), cssColorToHex(text)); }, [engine, page, text]);
  useEffect(() => { engine?.fontChanged(); }, [engine, monoFont]);

  // Where the tiles and panels are: read once a second while the scene runs, once for a still
  // frame, never while it is held. Read from the page's canvas view, the only one it runs behind.
  useEffect(() => {
    if (!engine) return;
    if (mode !== "hold") engine.setBoxes(boxesOnPage(frosted));
    engine.setMode(mode);
    if (mode !== "run") return;
    const id = setInterval(() => engine.setBoxes(boxesOnPage(frosted)), 1000);
    return () => clearInterval(id);
  }, [engine, mode, frosted]);

  // The sharks again whenever an agent comes, goes or changes to a status that changes its shark;
  // a turn that ends well is its shark's bite.
  useEffect(() => {
    if (!engine) return;
    const last = new Map(agents.map((a) => [a.tileId, statusOf(a.tileId)]));
    let sent = "";
    const send = () => {
      const sharks = roster(agents, statusOf);
      const key = rosterKey(sharks);
      if (key === sent) return;
      sent = key;
      engine.setRoster(sharks);
    };
    send();
    let replaying = true;
    const off = subscribeStatus((e) => {
      if (replaying || !last.has(e.tileId)) return;
      const was = last.get(e.tileId);
      last.set(e.tileId, e.status);
      if (was === e.status) return;
      if (turnEnded(was, e)) engine.finished(e.tileId);
      send();
    });
    replaying = false;
    return off;
  }, [engine, agents]);

  return <div ref={hostRef} className="hm-shoal" />;
}
