/**
 * Canvas floating "islands" — the Excalidraw-style toolbars overlaid on the
 * ReactFlow pane: the top-center tool island (spawn buttons + claude mode) and
 * the bottom-left zoom/nav island (+ optional FPS meter). Pure presentational
 * adapters driven entirely by props / react-flow's camera API — they hold no
 * Canvas state, so they live here to keep Canvas.tsx focused on orchestration.
 */
import { useEffect, useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import type { TileKind } from "./tile-kinds";

/** Top-center tool island — spawn terminal/claude/editor/diff/issues/frame. */
export function ToolIsland({
  present,
  repoPath,
  onToggle,
  onClaude,
  onFrame,
  claudeMode,
  onClaudeModeChange,
}: {
  present: ReadonlySet<TileKind>;
  repoPath: string | null;
  onToggle: (k: "tree" | "shell" | "diff" | "issues") => void;
  onClaude: () => void;
  onFrame: () => void;
  claudeMode: string;
  onClaudeModeChange: (m: string) => void;
}) {
  return (
    <div className="hm-island flex items-center gap-0.5 p-1.5">
      <ToolButton label="Terminal" hint="1" active={present.has("shell")} onClick={() => onToggle("shell")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4 6l2 2-2 2M8 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Claude" hint="2" accent active={present.has("claude")} onClick={onClaude}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>} />
      <select
        value={claudeMode}
        onChange={(e) => onClaudeModeChange(e.target.value)}
        title="Claude permission mode for new sessions"
        className="h-7 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md text-[10px] font-mono text-[var(--color-fg2)] px-1 outline-none cursor-pointer hover:text-[var(--color-fg)]"
      >
        <option value="default">default</option>
        <option value="plan">plan</option>
        <option value="acceptEdits">acceptEdits</option>
        <option value="auto">auto</option>
        <option value="dontAsk">dontAsk</option>
        <option value="bypassPermissions">bypass</option>
      </select>
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Explorer" hint="3" active={present.has("editor")} disabled={!repoPath} onClick={() => onToggle("tree")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.7 2.7 3 3.5 3h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Diff" hint="4" active={present.has("diff")} disabled={!repoPath} onClick={() => onToggle("diff")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 2v8m0 0a2 2 0 1 0 0 0Zm8-4v2m0 0a2 2 0 1 0 0 0Zm0 0v2a2 2 0 0 1-2 2H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Issues" hint="5" active={present.has("issues")} disabled={!repoPath} onClick={() => onToggle("issues")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2" y="2.5" width="5" height="11" rx="1" stroke="currentColor" strokeWidth="1.2"/><rect x="9" y="2.5" width="5" height="7" rx="1" stroke="currentColor" strokeWidth="1.2"/></svg>} />
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Frame" hint="6" onClick={onFrame}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M5 2v12M11 2v12M2 5h12M2 11h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>} />
    </div>
  );
}

function ToolButton({
  label,
  hint,
  icon,
  active,
  accent,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  active?: boolean;
  accent?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${label} — needs a repo` : `${label}  (${hint})`}
      className={`relative grid place-items-center size-9 rounded-lg transition-colors ${
        active
          ? accent
            ? "bg-[var(--color-brand)] text-white"
            : "bg-[var(--color-bg4)] text-[var(--color-fg)] ring-1 ring-[var(--color-brand)]"
          : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
      } ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
    >
      {icon}
      {/* Inherit text color (currentColor) so the hint stays legible on the
          active/accent fill — a fixed gray vanished on claude's blue bg. */}
      <kbd className="absolute bottom-0.5 right-1 font-mono text-[8px] leading-none opacity-60">{hint}</kbd>
    </button>
  );
}

/** Bottom-left zoom + nav island (Excalidraw footer). Uses react-flow's
 *  imperative camera API; lives inside <ReactFlow> so the hooks resolve. */
export function ZoomIsland({ tileCount, onReset, minimapOn, onToggleMinimap, onFocus }: { tileCount: number; onReset: () => void; minimapOn: boolean; onToggleMinimap: () => void; onFocus: () => void }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const pct = Math.round(zoom * 100);
  const [fpsOn, setFpsOn] = useState(false);
  return (
    <div className="flex items-center gap-1">
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
