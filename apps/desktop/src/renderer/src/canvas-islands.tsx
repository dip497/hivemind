/** Canvas camera controls. The standard workspace toolbar lives independently
 *  in workspace/standard-toolbar so scene views do not depend on xyflow here. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";

/** Bottom-left zoom + nav island (Excalidraw footer). Uses react-flow's
 *  imperative camera API; lives inside <ReactFlow> so the hooks resolve. */
export function ZoomIsland({ tileCount, onReset, minimapOn, onToggleMinimap, onFocus }: { tileCount: number; onReset: () => void; minimapOn: boolean; onToggleMinimap: () => void; onFocus: () => void }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const pct = Math.round(zoom * 100);
  const [fpsOn, setFpsOn] = useState(false);
  const toolbar = useRovingToolbar();
  return (
    <div className="flex items-center gap-1" role="toolbar" aria-label="Canvas controls" ref={toolbar.ref} onKeyDown={toolbar.onKeyDown}>
      <div className="hm-island flex items-center overflow-hidden">
        <IslandBtn title="Zoom out (Ctrl -)" onClick={() => zoomOut({ duration: 150 })}>
          <svg width="13" height="13" viewBox="0 0 14 14"><path d="M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </IslandBtn>
        <button
          onClick={() => zoomTo(1, { duration: 150 })}
          title="Reset to 100% (Ctrl 1)"
          className="px-2 h-8 text-[11px] font-mono tabular-nums text-[var(--color-fg2)] hover:text-[var(--color-fg)] min-w-[3.2rem]"
        >{pct}%</button>
        <IslandBtn title="Zoom in (Ctrl +)" onClick={() => zoomIn({ duration: 150 })}>
          <svg width="13" height="13" viewBox="0 0 14 14"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </IslandBtn>
      </div>
      <div className="hm-island flex items-center overflow-hidden">
        <IslandBtn title="Fit to view (Ctrl 0)" onClick={() => fitView({ duration: 200, padding: 0.2 })}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
        <IslandBtn title="Focus selected (.)  ·  Esc to fit all" onClick={onFocus}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.3"/><path d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
        </IslandBtn>
        <IslandBtn title="Reset tile layout for this project" onClick={onReset}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11 1v3H8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
        <IslandBtn title={minimapOn ? "Hide minimap" : "Show minimap"} onClick={onToggleMinimap}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" opacity={minimapOn ? 1 : 0.5}><rect x="1.5" y="2.5" width="11" height="9" rx="1.2" stroke="currentColor" strokeWidth="1.2"/><rect x="7.5" y="6.5" width="3.5" height="3" rx="0.6" fill="currentColor"/></svg>
        </IslandBtn>
        <IslandBtn title={fpsOn ? "Hide FPS meter" : "Show FPS meter (watch it while dragging)"} onClick={() => setFpsOn((v) => !v)}>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" opacity={fpsOn ? 1 : 0.5}><path d="M2 10l3-4 2.5 2L12 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </IslandBtn>
      </div>
      {fpsOn && <FpsMeter />}
      <span className="ml-1 text-[10px] text-[var(--color-fg3)] font-mono tabular-nums select-none">
        {tileCount} {tileCount === 1 ? "tile" : "tiles"}
      </span>
    </div>
  );
}

/** The cluster is one tab stop; arrows move inside it, as a toolbar should. */
function useRovingToolbar() {
  const ref = useRef<HTMLDivElement>(null);
  const items = useCallback(() => [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])], []);
  // A button's tabIndex reads 0 by default, so the one we chose carries a mark of its own.
  useEffect(() => {
    const list = items();
    if (list.some((b) => b.dataset.roving === "on")) return;
    list.forEach((b, i) => { b.tabIndex = i === 0 ? 0 : -1; if (i === 0) b.dataset.roving = "on"; });
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const list = items();
    const from = list.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : (Math.max(from, 0) + step + list.length) % list.length;
    e.preventDefault();
    list.forEach((b, i) => { b.tabIndex = i === to ? 0 : -1; if (i === to) b.dataset.roving = "on"; else delete b.dataset.roving; });
    list[to]?.focus();
  };
  return { ref, onKeyDown };
}

/** Live FPS readout (rAF-sampled, updated 2×/s). Off by default — only mounts
 *  (and runs its rAF loop) when toggled on, so it never costs anything idle.
 *  Color: green ≥55 · amber 30-54 · red <30. Watch it dip while dragging a tile
 *  to measure jank empirically (the headless test harness can't). */
function FpsMeter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const tick = (t: number) => {
      frames++;
      if (t - last >= 500) {
        setFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const color = fps >= 55 ? "var(--color-ok)" : fps >= 30 ? "var(--color-warn)" : "var(--color-err)";
  return (
    <span
      className="ml-1 text-[10px] font-mono tabular-nums select-none"
      style={{ color }}
      title="frames/sec — drag a tile and watch this; a big dip = jank to fix"
    >
      {fps} fps
    </span>
  );
}

function IslandBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="grid place-items-center size-8 text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] transition-colors"
    >{children}</button>
  );
}
