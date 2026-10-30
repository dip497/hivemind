/** A live wallpaper a package ships: a scene behind the canvas, told each agent's creature, where the
 *  tiles are, the colours and whether to run. One may draw the agents (the pointer over a creature
 *  it names shows its agent's name, and a click there goes to its tile) or a world of its own that
 *  ignores them, as the Live scenes package does. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { statusOf, subscribeStatus } from "../agent-status-bus";
import { cssColorToHex } from "../workspace/css-color";
import { statusWord } from "../workspace/status-look";
import type { SceneEngine } from "./page-scene";
import { PluginEngine, type PluginWallpaper } from "./plugin-engine";
import { roster, turnEnded, type SceneAgent } from "./roster";
import type { Box, CreatureSpec, SceneMode } from "./scene";
import { turnWallpaperOff } from "./wallpaper-store";

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

/** Where the name goes: beside the pointer, on its left near the window's right edge so it is never
 *  cut off. */
function labelAt(at: { x: number; y: number }): { left: string; right: string; top: string } {
  const flip = at.x > window.innerWidth - 260;
  return { left: flip ? "" : `${at.x + 14}px`, right: flip ? `${window.innerWidth - at.x + 14}px` : "", top: `${at.y + 16}px` };
}

const rosterKey = (creatures: CreatureSpec[]) => creatures.map((s) => `${s.key}:${s.variant}:${s.size}:${s.mood}`).join("|");

export function LiveWallpaper({ scene, colour, agents, paused, animate, frosted, seeThrough, page, text, attention, dark, monoFont, nameOf, onOpen }: {
  /** A package's live wallpaper. */
  scene: PluginWallpaper;
  /** The person's **Colour** switch, for a wallpaper that draws in colours of its own. */
  colour: boolean;
  /** The workspace's agents, the same array until one comes, goes or falls asleep. */
  agents: readonly SceneAgent[];
  /** The window is hidden or not focused, or something covers the workspace. Not when the person
   *  is idle: someone resting their hands is there to watch it. */
  paused: boolean;
  /** The person's Animation switch. */
  animate: boolean;
  /** Glass is on: the panels over the scene are frosted, and the creatures swim under them. */
  frosted: boolean;
  /** Tool content is frosted too: a creature under a tile shows through it, soft. */
  seeThrough: boolean;
  /** The theme's page and text colours (CSS), and its "needs you" colour; whether it is dark. */
  page: string;
  text: string;
  attention: string;
  dark: boolean;
  /** The terminal's font, which the scene's characters take (read from the page; this says when). */
  monoFont: string;
  /** An agent's tile's name, for the label over its creature. */
  nameOf: (tileId: string) => string | null;
  /** Go to an agent's tile: its creature was clicked. */
  onOpen: (tileId: string) => void;
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<SceneEngine | null>(null);
  /** The creature under the pointer, and where the pointer was when it came; its name then goes
   *  with the pointer, set on the label itself, not drawn again. */
  const [over, setOver] = useState<{ key: string; x: number; y: number } | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const sceneKey = `${scene.id} ${scene.url}`;
  const reduced = useSyncExternalStore(lessMotion.watch, lessMotion.now, lessMotion.now);
  const contrast = useSyncExternalStore(moreContrast.watch, moreContrast.now, moreContrast.now);
  const solid = useSyncExternalStore(lessTransparency.watch, lessTransparency.now, lessTransparency.now);
  const shown = !contrast && !solid;
  const mode: SceneMode = !animate || reduced ? "still" : paused ? "hold" : "run";

  // The colours it is drawn in now: a package's page is told them first, with everything else.
  const look = { page: cssColorToHex(page), text: cssColorToHex(text), attention: cssColorToHex(attention), dark, colour, mono: monoFont };
  const lookRef = useRef(look);
  lookRef.current = look;

  // A frame of its own for each wallpaper.
  useEffect(() => {
    if (!shown) return;
    const events = {
      hover: (key: string | null, at: { x: number; y: number }) => setOver(key ? { key, ...at } : null),
      move: (at: { x: number; y: number }) => { if (labelRef.current) Object.assign(labelRef.current.style, labelAt(at)); },
      open: (key: string) => openRef.current(key),
      disable: (reason: string) => {
        turnWallpaperOff(scene.id, reason);
        toast.error(`The ${scene.name} live wallpaper was turned off: ${reason}. The plain background shows until Hivemind starts again.`);
      },
    };
    const e = new PluginEngine(hostRef.current!, scene, lookRef.current, events);
    setEngine(e);
    return () => { e.destroy(); setEngine(null); setOver(null); };
    // `scene` is the same scene while its key is.
  }, [shown, sceneKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pointer shows it can go to an agent while it is over its creature.
  useEffect(() => {
    if (!over) return;
    document.documentElement.dataset.overCreature = "";
    return () => { delete document.documentElement.dataset.overCreature; };
  }, [over]);

  useEffect(() => { engine?.setLook(lookRef.current); }, [engine, page, text, attention, dark, colour, monoFont]);
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

  const name = over ? nameOf(over.key) : null;
  return <>
    <div ref={hostRef} className="hm-live" />
    {/* Over everything, as a tooltip is: the wallpaper's own layer is behind the canvas. */}
    {over && name && createPortal(
      <div ref={labelRef} className="hm-live-label" role="tooltip" data-creature={over.key} style={labelAt(over)}>
        <span className="hm-live-label-name">{name}</span> · {statusWord(statusOf(over.key) ?? null)}
      </div>,
      document.body,
    )}
  </>;
}
