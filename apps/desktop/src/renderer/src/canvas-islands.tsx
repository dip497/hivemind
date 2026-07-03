/**
 * Canvas floating "islands" — the Excalidraw-style toolbars overlaid on the
 * ReactFlow pane: the top-center tool island (spawn buttons + claude mode) and
 * the bottom-left zoom/nav island (+ optional FPS meter). Pure presentational
 * adapters driven entirely by props / react-flow's camera API — they hold no
 * Canvas state, so they live here to keep Canvas.tsx focused on orchestration.
 */
import { useEffect, useRef, useState } from "react";
import { useReactFlow, useStore } from "@xyflow/react";
import { AGENTS, AgentIcon, agentById } from "./agents";

/** Top-center tool island — spawn terminal/agent/editor/diff/issues/frame. */
export function ToolIsland({
  repoPath,
  onToggle,
  agentSel,
  onAgentChange,
  onSpawnAgent,
  claudeModel,
  onModelChange,
  onFrame,
  onBrowser,
  onTheme,
  updateAvailable,
  onUpgrade,
  upgrading,
}: {
  repoPath: string | null;
  onToggle: (k: "tree" | "shell" | "diff" | "issues") => void;
  /** Currently-selected agent id (which the spawn button creates). */
  agentSel: string;
  onAgentChange: (id: string) => void;
  onSpawnAgent: (agent: { id: string; cmd: string; defaultArgs?: string[]; label: string }) => void;
  /** Default Claude model the next spawn launches with ("default" | "opus" |
   *  "sonnet"). claude-only — ignored for other runtimes. */
  claudeModel: string;
  onModelChange: (model: string) => void;
  onFrame: () => void;
  onBrowser: () => void;
  onTheme: () => void;
  /** A newer GitHub release exists → show the "Update available" pill next to
   *  Theme. The full update UI lives in the top-right Settings dialog. */
  updateAvailable: boolean;
  /** Run the upgrade + restart (from the pill). */
  onUpgrade: () => void;
  /** An upgrade is in flight — the pill shows a spinner + "Updating…" and is
   *  click-inert so it can't be fired twice. */
  upgrading: boolean;
}) {
  const enabled = AGENTS.filter((a) => a.enabled);
  const sel = agentById(agentSel) ?? enabled[0]!;
  const [agentMenu, setAgentMenu] = useState(false);
  const agentBtnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!agentMenu) return;
    const onDoc = (e: MouseEvent) => { if (agentBtnRef.current && !agentBtnRef.current.contains(e.target as Node)) setAgentMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [agentMenu]);

  // Claude model picker (default | opus | sonnet). Only meaningful when the
  // selected agent is claude — a `--model` alias is claude-only.
  const MODELS = [
    { id: "default", label: "Default" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
  ] as const;
  const selModel = MODELS.find((m) => m.id === claudeModel) ?? MODELS[0];
  const [modelMenu, setModelMenu] = useState(false);
  const modelBtnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelMenu) return;
    const onDoc = (e: MouseEvent) => { if (modelBtnRef.current && !modelBtnRef.current.contains(e.target as Node)) setModelMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [modelMenu]);

  return (
    <div className="hm-island flex items-center gap-0.5 p-1.5">
      <ToolButton label="Terminal" hint="1" onClick={() => onToggle("shell")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/><path d="M4 6l2 2-2 2M8 10h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>} />
      {/* Agent button — spawns the SELECTED agent; the ▾ opens a switcher. */}
      <div ref={agentBtnRef} className="relative flex items-center">
        <ToolButton label={sel.label} hint="2" onClick={() => onSpawnAgent(sel)} icon={<AgentIcon id={sel.id} size={15} />} />
        <button
          onClick={() => setAgentMenu((o) => !o)}
          title="Switch agent"
          aria-label="switch agent"
          className="grid place-items-center h-9 w-4 -ml-1 text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer"
        >
          <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
        </button>
        {agentMenu && (
          <div className="absolute top-full left-0 mt-1 z-30 min-w-[140px] hm-island rounded-lg p-1">
            {enabled.map((a) => (
              <button
                key={a.id}
                onClick={() => { onAgentChange(a.id); setAgentMenu(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left cursor-pointer hover:bg-[var(--color-bg4)] ${a.id === sel.id ? "text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}
              >
                <a.icon size={14} />
                <span className="flex-1">{a.label}</span>
                {a.id === sel.id && <span className="text-[var(--color-fg3)] text-[10px]">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Claude model picker — sets the DEFAULT model the next claude spawn
          launches with (claude-only `--model`). Mirrors the agent switcher. */}
      <div ref={modelBtnRef} className="relative flex items-center">
        <button
          onClick={() => setModelMenu((o) => !o)}
          title="Claude model for new spawns (claude-only)"
          aria-label="claude model"
          className="flex items-center gap-1 h-9 px-2 rounded-lg text-[11px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] transition-colors cursor-pointer"
        >
          <span>{selModel.label}</span>
          <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" /></svg>
        </button>
        {modelMenu && (
          <div className="absolute top-full left-0 mt-1 z-30 min-w-[120px] hm-island rounded-lg p-1">
            {MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => { onModelChange(m.id); setModelMenu(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left cursor-pointer hover:bg-[var(--color-bg4)] ${m.id === selModel.id ? "text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}
              >
                <span className="flex-1">{m.label}</span>
                {m.id === selModel.id && <span className="text-[var(--color-fg3)] text-[10px]">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Explorer" hint="3" disabled={!repoPath} onClick={() => onToggle("tree")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 4.5C2 3.7 2.7 3 3.5 3h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5v-7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>} />
      <ToolButton label="Diff" hint="4" disabled={!repoPath} onClick={() => onToggle("diff")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="4.5" cy="4" r="1.7"/><circle cx="11.5" cy="12" r="1.7"/><path d="M4.5 5.7v2.8a2 2 0 0 0 2 2H9"/><path d="M11.5 10.3V7.5a2 2 0 0 0-2-2H7"/></svg>} />
      <ToolButton label="Issues" hint="5" disabled={!repoPath} onClick={() => onToggle("issues")}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.3l1.1 1.1 1.8-1.9M2.5 9.3l1.1 1.1 1.8-1.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M7.5 4.6h6M7.5 9.6h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>} />
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Frame" hint="6" onClick={onFrame}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M5 2v12M11 2v12M2 5h12M2 11h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>} />
      <ToolButton label="Browser" hint="7" onClick={onBrowser}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2"/><ellipse cx="8" cy="8" rx="2.6" ry="6" stroke="currentColor" strokeWidth="1.1"/><path d="M2 8h12" stroke="currentColor" strokeWidth="1.1"/></svg>} />
      <div className="mx-0.5 h-5 w-px bg-[var(--color-line2)]" aria-hidden />
      <ToolButton label="Theme" hint="8" onClick={onTheme}
        icon={<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1.5a6.5 6.5 0 0 0 0 13c.83 0 1.5-.67 1.5-1.5 0-.4-.16-.76-.41-1.03-.24-.26-.39-.6-.39-.97 0-.83.67-1.5 1.5-1.5H11a3.5 3.5 0 0 0 3.5-3.5C14.5 4.3 11.6 1.5 8 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/><circle cx="5" cy="6.5" r="0.9" fill="currentColor"/><circle cx="8" cy="5" r="0.9" fill="currentColor"/><circle cx="11" cy="6.5" r="0.9" fill="currentColor"/></svg>} />
      {/* "Update available — restart to update" pill. Only when a newer release
          exists; clicking runs the installer + quits. (Full update status +
          version + repo/license live in the top-right Settings dialog.) */}
      {updateAvailable && (
        <button
          onClick={onUpgrade}
          disabled={upgrading}
          aria-busy={upgrading}
          title={upgrading ? "Downloading and installing the update…" : "Update available — click to update and restart"}
          className="ml-1 flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium text-[var(--color-warn)] bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-warn)_26%,transparent)] disabled:cursor-default whitespace-nowrap cursor-pointer"
        >
          {upgrading ? (
            <>
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>
              Updating…
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M7 9.5V2.5M4 5l3-3 3 3M2.5 11.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Update available
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ToolButton({
  label,
  hint,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? `${label} — needs a repo` : `${label}  (${hint})`}
      className={`relative grid place-items-center size-9 rounded-lg transition-colors cursor-pointer ${
        // These are spawn/toggle ACTIONS, not stateful toggles — showing them
        // "selected" because a tile of that kind happens to be open was just
        // confusing. All buttons read the same; only hover responds.
        disabled
          ? "text-[var(--color-fg2)] opacity-30 cursor-not-allowed"
          : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
      }`}
    >
      {icon}
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
