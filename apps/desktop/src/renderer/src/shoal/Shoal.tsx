/** The Shoal wallpaper: fish and sharks drawn in characters behind the canvas, one shark per agent,
 *  in the theme's page and text colours. */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { statusOf, subscribeStatus } from "../agent-status-bus";
import { cssColorToHex } from "../workspace/css-color";
import { ShoalEngine, type ShoalMode } from "./engine";
import { roster, type ShoalAgent } from "./roster";
import type { Box } from "./world";

const lessMotion = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
const watchMotion = (cb: () => void) => {
  lessMotion?.addEventListener("change", cb);
  return () => lessMotion?.removeEventListener("change", cb);
};
const motionReduced = () => lessMotion?.matches === true;

/** What the scene keeps out from under: the canvas's tiles (not its frames, which are zones the
 *  water shows through), the Layers panel and the toolbars. */
const SOLID = '.react-flow__node:not(.react-flow__node-frame)[data-id], aside[aria-label="Layers"], .hm-island';
function boxesOnPage(): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(SOLID)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, ...(el.dataset.id ? { key: el.dataset.id } : {}) });
  }
  return out;
}

export function Shoal({ agents, paused, animate, page, text }: {
  /** The workspace's agents, the same array until one comes, goes or falls asleep. */
  agents: readonly ShoalAgent[];
  /** The window is hidden, unfocused or idle, or something covers the workspace. */
  paused: boolean;
  /** The person's Animation switch. */
  animate: boolean;
  /** The theme's page and text colours (CSS). */
  page: string;
  text: string;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ShoalEngine | null>(null);
  const reduced = useSyncExternalStore(watchMotion, motionReduced, motionReduced);
  const mode: ShoalMode = !animate || reduced ? "still" : paused ? "hold" : "run";

  useEffect(() => {
    const engine = new ShoalEngine(canvasRef.current!);
    engineRef.current = engine;
    return () => { engine.destroy(); engineRef.current = null; };
  }, []);

  useEffect(() => { engineRef.current?.setColours(cssColorToHex(page), cssColorToHex(text)); }, [page, text]);

  // Where the tiles and panels are: read once a second while the scene runs, once for a still
  // frame, never while it is held. Read from the page, so it holds whatever the view.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (mode !== "hold") engine.setBoxes(boxesOnPage());
    engine.setMode(mode);
    if (mode !== "run") return;
    const id = setInterval(() => engine.setBoxes(boxesOnPage()), 1000);
    return () => clearInterval(id);
  }, [mode]);

  // The sharks again whenever an agent comes, goes or changes status. A turn that ends (at work,
  // then ready, and not because the person interrupted it) is its shark's bite.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const last = new Map(agents.map((a) => [a.tileId, statusOf(a.tileId)]));
    engine.setRoster(roster(agents, statusOf));
    let replaying = true;
    const off = subscribeStatus((e) => {
      if (replaying || !last.has(e.tileId)) return;
      const was = last.get(e.tileId);
      last.set(e.tileId, e.status);
      if (was === e.status) return;
      if (was === "working" && e.status === "idle" && !e.synthetic) engine.finished(e.tileId);
      engine.setRoster(roster(agents, statusOf));
    });
    replaying = false;
    return off;
  }, [agents]);

  return <canvas ref={canvasRef} className="hm-shoal" aria-hidden="true" />;
}
