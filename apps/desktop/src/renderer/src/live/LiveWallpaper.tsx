/** A live wallpaper: a scene drawn in characters behind the canvas (Shoal's sharks, Koi Pond's koi
 *  …), one creature per agent, in the theme's page and text colours or the scene's own. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { statusOf, subscribeStatus } from "../agent-status-bus";
import { cssColorToHex } from "../workspace/css-color";
import { LiveEngine, type SceneId } from "./engine";
import { roster, turnEnded, type SceneAgent } from "./roster";
import type { Box, CreatureSpec, SceneMode } from "./scene";

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

/** What the scene keeps out from under, and draws no creature under: the canvas's tiles (not its
 *  frames, which are zones the water shows through), and the Layers panel and the toolbars unless
 *  they are glass. A frosted panel shows a creature through it, softened, as it passes under; a
 *  tile stays solid unless it is see-through, so its text never runs over one. */
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

const rosterKey = (creatures: CreatureSpec[]) => creatures.map((s) => `${s.key}:${s.variant}:${s.size}:${s.mood}`).join("|");

export function LiveWallpaper({ scene, colour, agents, paused, animate, frosted, seeThrough, page, text, monoFont }: {
  scene: SceneId;
  /** Drawn in the scene's own colours, not the theme's page and text. */
  colour: boolean;
  /** The workspace's agents, the same array until one comes, goes or falls asleep. */
  agents: readonly SceneAgent[];
  /** The window is hidden, unfocused or idle, or something covers the workspace. */
  paused: boolean;
  /** The person's Animation switch. */
  animate: boolean;
  /** Glass is on: the panels over the scene are frosted, and the creatures swim under them. */
  frosted: boolean;
  /** Tool content is frosted too: a creature under a tile shows through it, soft. */
  seeThrough: boolean;
  /** The theme's page and text colours (CSS). */
  page: string;
  text: string;
  /** The terminal's font, which the scene's characters take (read from the page; this says when). */
  monoFont: string;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<LiveEngine | null>(null);
  const reduced = useSyncExternalStore(lessMotion.watch, lessMotion.now, lessMotion.now);
  const contrast = useSyncExternalStore(moreContrast.watch, moreContrast.now, moreContrast.now);
  const solid = useSyncExternalStore(lessTransparency.watch, lessTransparency.now, lessTransparency.now);
  const shown = !contrast && !solid;
  const mode: SceneMode = !animate || reduced ? "still" : paused ? "hold" : "run";

  // A scene of its own for each: a canvas is handed to one worker only once.
  useEffect(() => {
    if (!shown) return;
    const e = new LiveEngine(hostRef.current!, scene);
    setEngine(e);
    return () => { e.destroy(); setEngine(null); };
  }, [shown, scene]);

  useEffect(() => { engine?.setLook({ page: cssColorToHex(page), text: cssColorToHex(text), colour }); }, [engine, page, text, colour]);
  useEffect(() => { engine?.fontChanged(); }, [engine, monoFont]);

  // Where the tiles and panels are: read once a second while the scene runs, once for a still
  // frame, never while it is held; and while the canvas moves (a pan, a zoom, a tile dragged or
  // resized), at most once a frame, so what is drawn under a tile keeps to it. Read from the page's
  // canvas view, the only one it runs behind. Only the viewport's and the tiles' own style is
  // watched: what a tile shows inside it (a terminal's output) changes nothing here.
  useEffect(() => {
    if (!engine) return;
    const send = () => engine.setBoxes(boxesOnPage(frosted), frosted && seeThrough);
    // Before the mode: a still picture is settled with the tiles where they are.
    if (mode !== "hold") send();
    engine.setMode(mode);
    if (mode === "hold") return;
    let queued = false;
    const moved = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; send(); });
    });
    const watch = () => {
      moved.disconnect();
      const style = { attributes: true, attributeFilter: ["style"] };
      const viewport = document.querySelector(".react-flow__viewport");
      if (viewport) moved.observe(viewport, style);
      for (const tile of document.querySelectorAll(TILES)) moved.observe(tile, style);
    };
    watch();
    const id = mode === "run" ? setInterval(() => { send(); watch(); }, 1000) : undefined;
    return () => { clearInterval(id); moved.disconnect(); };
  }, [engine, mode, frosted, seeThrough]);

  // The creatures again whenever an agent comes, goes or changes to a status that changes its
  // creature; a turn that ends well its creature shows.
  useEffect(() => {
    if (!engine) return;
    const last = new Map(agents.map((a) => [a.tileId, statusOf(a.tileId)]));
    let sent = "";
    const send = () => {
      const creatures = roster(agents, statusOf);
      const key = rosterKey(creatures);
      if (key === sent) return;
      sent = key;
      engine.setRoster(creatures);
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

  return <div ref={hostRef} className="hm-live" />;
}
