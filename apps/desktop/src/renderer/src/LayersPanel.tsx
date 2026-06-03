/**
 * LayersPanel — a Figma-style "layers" rail on the left of the canvas. Lists
 * every open tile GROUPED BY FRAME (workspace), each with a live status dot and
 * click-to-focus. Collapsible per group + hideable as a whole.
 *
 * It reads the same `agent-status-bus` that drives the frame-header chips, so a
 * tile's status here stays in sync with everywhere else. Pure presentational +
 * its own status subscription; Canvas owns the data + focus actions.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Layers, ChevronRight, ChevronDown, Square, GitBranch } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";

export type LayerKind = "claude" | "terminal" | "editor" | "diff" | "issues";

export interface LayerTile {
  id: string;
  kind: LayerKind;
  name: string;
  /** Frame id this tile belongs to, or null when loose on the canvas. */
  frameId: string | null;
}

export interface LayerFrame {
  id: string;
  title: string;
  color: string;
  /** Set => this is a worktree sub-frame nested under parentFrameId. */
  parentFrameId?: string;
  /** Branch of a worktree sub-frame (shown as a muted tag). */
  branch?: string;
}

interface Props {
  frames: LayerFrame[];
  tiles: LayerTile[];
  selectedTileId: string | null;
  onFocusTile: (id: string) => void;
  onFocusFrame: (id: string) => void;
}

const STATUS_COLOR: Record<TileStatusKind, string> = {
  working: "var(--color-brand)",
  idle: "var(--color-fg3)",
  blocked: "var(--color-warn)",
  permission: "var(--color-warn)",
  question: "var(--color-warn)",
  exited: "var(--color-err)",
};

const KIND_GLYPH: Record<LayerKind, string> = {
  claude: "✦",
  terminal: "›_",
  editor: "{}",
  diff: "±",
  issues: "◔",
};

export function LayersPanel({ frames, tiles, selectedTileId, onFocusTile, onFocusFrame }: Props) {
  // Persisted: panel hidden + which frame groups are collapsed. Default HIDDEN
  // (just a discoverable pill) — the panel is a left overlay and would occlude
  // tile controls (e.g. the diff stage/commit bar) if shown over a tile near
  // the left edge. User opens it on demand; the choice persists.
  const [hidden, setHidden] = useState<boolean>(
    () => localStorage.getItem("hivemind:layers-hidden") !== "0",
  );
  useEffect(() => { localStorage.setItem("hivemind:layers-hidden", hidden ? "1" : "0"); }, [hidden]);
  // ⌘/Ctrl+L toggles the panel open/closed (dispatched from App's menu bridge;
  // works even over a focused terminal since main forwards the key). The header
  // × and the collapsed pill remain for mouse.
  useEffect(() => {
    const onToggle = () => setHidden((h) => !h);
    window.addEventListener("hivemind:toggle-layers", onToggle);
    return () => window.removeEventListener("hivemind:toggle-layers", onToggle);
  }, []);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Live status per tile, from the shared bus (same source as frame chips).
  const [status, setStatus] = useState<Map<string, TileStatusKind>>(new Map());
  useEffect(() => {
    return subscribeStatus((e) => {
      setStatus((m) => {
        if (m.get(e.tileId) === e.status) return m;
        const next = new Map(m);
        next.set(e.tileId, e.status);
        return next;
      });
    });
  }, []);

  const toggleGroup = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Aggregate status across open tiles — drives the at-a-glance summary in the
  // header AND the badge on the collapsed pill (so a hidden panel still signals
  // "an agent needs you" / "agents are working"). needs-you wins over working.
  const needsYou = tiles.filter((t) => {
    const s = status.get(t.id);
    return s === "blocked" || s === "permission" || s === "question";
  }).length;
  const working = tiles.filter((t) => status.get(t.id) === "working").length;

  // Collapsed pill when hidden — a single button to bring it back. A status dot
  // rides the corner so you don't have to open the panel to know an agent is
  // waiting on you (warn) or busy (brand).
  if (hidden) {
    const badge = needsYou > 0 ? "var(--color-warn)" : working > 0 ? "var(--color-brand)" : null;
    return (
      <button
        onClick={() => setHidden(false)}
        className="pointer-events-auto absolute left-3 top-16 z-20 size-8 grid place-items-center rounded-lg hm-island text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
        title={
          needsYou > 0 ? `Show layers — ${needsYou} agent(s) need you`
          : working > 0 ? `Show layers — ${working} working`
          : "Show layers"
        }
        aria-label="show layers"
      >
        <Layers size={15} />
        {badge && (
          <span
            aria-hidden
            className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--color-bg2)] ${needsYou > 0 ? "animate-pulse" : ""}`}
            style={{ background: badge }}
          />
        )}
      </button>
    );
  }

  // Frame forest: top-level (repo) frames each own their worktree sub-frames.
  // A child whose parent is missing falls back to top-level (defensive).
  const topFrames = frames.filter((f) => !f.parentFrameId || !frames.some((p) => p.id === f.parentFrameId));
  const childFramesOf = (fid: string) => frames.filter((f) => f.parentFrameId === fid);
  const tilesOf = (fid: string) => tiles.filter((t) => t.frameId === fid);
  const looseTiles = tiles.filter((t) => !t.frameId || !frames.some((f) => f.id === t.frameId));
  const totalGroups = topFrames.length + (looseTiles.length ? 1 : 0);

  const renderTile = (t: LayerTile, depth: number): ReactNode => {
    const st = status.get(t.id) ?? "idle";
    const sel = t.id === selectedTileId;
    return (
      <button
        key={t.id}
        onClick={() => onFocusTile(t.id)}
        style={{ paddingLeft: 16 + depth * 14 }}
        className={`w-full flex items-center gap-2 pr-2 py-1 text-left rounded-sm ${
          sel ? "bg-[var(--color-bg4)] text-[var(--color-fg)]" : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
        }`}
        title={`${t.name} · ${st}`}
      >
        <span aria-hidden className="w-3.5 shrink-0 text-center font-mono text-[10px] text-[var(--color-fg3)]">{KIND_GLYPH[t.kind]}</span>
        <span className="truncate flex-1">{t.name}</span>
        {st !== "idle" && (
          <span className="shrink-0 text-[9px] tabular-nums" style={{ color: STATUS_COLOR[st] }}>
            {st === "permission" || st === "question" ? "needs you" : st}
          </span>
        )}
        <span
          aria-hidden
          className={`size-1.5 rounded-full shrink-0 ${st === "working" || st === "blocked" || st === "permission" || st === "question" ? "animate-pulse" : ""}`}
          style={{ background: STATUS_COLOR[st] }}
          title={st}
        />
      </button>
    );
  };

  // A frame group: header + its tiles, then its worktree child groups indented
  // one level deeper (recursion is depth-bounded at 2, but written generally).
  const renderFrameGroup = (frame: LayerFrame, depth: number): ReactNode => {
    const gid = frame.id;
    const isCollapsed = collapsed.has(gid);
    const items = tilesOf(gid);
    const kids = childFramesOf(gid);
    const isWt = !!frame.parentFrameId;
    return (
      <div key={gid} className="mb-0.5">
        <div className="flex items-center gap-1 py-1 pr-1.5" style={{ paddingLeft: 6 + depth * 14 }}>
          <button
            onClick={() => toggleGroup(gid)}
            className="size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
            aria-label={isCollapsed ? "expand" : "collapse"}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          <button
            onClick={() => onFocusFrame(frame.id)}
            className="flex-1 flex items-center gap-1.5 min-w-0 text-left text-[11px] font-medium text-[var(--color-fg)]"
            title={isWt ? `Focus worktree ${frame.branch ?? frame.title}` : `Focus ${frame.title}`}
          >
            {isWt ? (
              <GitBranch size={11} className="shrink-0" style={{ color: frame.color }} />
            ) : (
              <Square size={9} fill={frame.color} stroke={frame.color} className="shrink-0" />
            )}
            <span className="truncate">{frame.title}</span>
            <span className="ml-auto font-mono text-[10px] text-[var(--color-fg3)]">{items.length + kids.length}</span>
          </button>
        </div>
        {!isCollapsed && (
          <>
            {items.map((t) => renderTile(t, depth + 1))}
            {kids.map((k) => renderFrameGroup(k, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <aside
      className="pointer-events-auto absolute left-3 top-16 bottom-3 z-20 w-[212px] flex flex-col hm-island rounded-lg overflow-hidden"
      aria-label="Layers"
    >
      <header className="flex items-center gap-2 px-2.5 h-8 border-b border-[var(--color-line2)] text-[11px] font-semibold text-[var(--color-fg2)]">
        <Layers size={13} className="text-[var(--color-fg3)]" />
        <span>Layers</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] tabular-nums">
          {needsYou > 0 && (
            <span className="flex items-center gap-0.5 text-[var(--color-warn)]" title={`${needsYou} need you`}>
              <span aria-hidden className="size-1.5 rounded-full animate-pulse" style={{ background: "var(--color-warn)" }} />
              {needsYou}
            </span>
          )}
          {working > 0 && (
            <span className="flex items-center gap-0.5 text-[var(--color-brand)]" title={`${working} working`}>
              <span aria-hidden className="size-1.5 rounded-full" style={{ background: "var(--color-brand)" }} />
              {working}
            </span>
          )}
          <span className="text-[var(--color-fg3)]">{tiles.length}</span>
        </span>
        <button
          onClick={() => setHidden(true)}
          className="size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          title="Hide layers"
          aria-label="hide layers"
        >×</button>
      </header>

      <div className="flex-1 overflow-y-auto py-1 text-[12px]">
        {totalGroups === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">No tiles open.</div>
        )}
        {topFrames.map((f) => renderFrameGroup(f, 0))}
        {looseTiles.length > 0 && (
          <div className="mb-0.5">
            <div className="flex items-center gap-1 py-1 pr-1.5 pl-1.5">
              <span aria-hidden className="size-4 shrink-0" />
              <span className="flex-1 flex items-center gap-1.5 min-w-0 text-[11px] font-medium text-[var(--color-fg2)]">
                <span aria-hidden className="size-2 shrink-0 rounded-[2px] border border-[var(--color-line2)]" />
                <span className="truncate">Canvas</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--color-fg3)]">{looseTiles.length}</span>
              </span>
            </div>
            {looseTiles.map((t) => renderTile(t, 1))}
          </div>
        )}
      </div>
    </aside>
  );
}
