/**
 * LayersPanel — a Figma-style "layers" rail on the left of the canvas. Lists
 * every open tile GROUPED BY FRAME (workspace), each with a live status dot and
 * click-to-focus. Collapsible per group + hideable as a whole.
 *
 * It reads the same `agent-status-bus` that drives the frame-header chips, so a
 * tile's status here stays in sync with everywhere else. Pure presentational +
 * its own status subscription; Canvas owns the data + focus actions.
 */
import { useEffect, useState } from "react";
import { Layers, ChevronRight, ChevronDown, Square } from "lucide-react";
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

  // Collapsed pill when hidden — a single button to bring it back.
  if (hidden) {
    return (
      <button
        onClick={() => setHidden(false)}
        className="pointer-events-auto absolute left-3 top-16 z-20 size-8 grid place-items-center rounded-lg hm-island text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
        title="Show layers"
        aria-label="show layers"
      >
        <Layers size={15} />
      </button>
    );
  }

  const looseTiles = tiles.filter((t) => !t.frameId || !frames.some((f) => f.id === t.frameId));
  const groups: Array<{ frame: LayerFrame | null; items: LayerTile[] }> = [
    ...frames.map((f) => ({ frame: f, items: tiles.filter((t) => t.frameId === f.id) })),
    ...(looseTiles.length ? [{ frame: null, items: looseTiles }] : []),
  ];

  return (
    <aside
      className="pointer-events-auto absolute left-3 top-16 bottom-3 z-20 w-[212px] flex flex-col hm-island rounded-lg overflow-hidden"
      aria-label="Layers"
    >
      <header className="flex items-center gap-2 px-2.5 h-8 border-b border-[var(--color-line2)] text-[11px] font-semibold text-[var(--color-fg2)]">
        <Layers size={13} className="text-[var(--color-fg3)]" />
        <span>Layers</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--color-fg3)] tabular-nums">
          {tiles.length}
        </span>
        <button
          onClick={() => setHidden(true)}
          className="size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          title="Hide layers"
          aria-label="hide layers"
        >×</button>
      </header>

      <div className="flex-1 overflow-y-auto py-1 text-[12px]">
        {groups.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[var(--color-fg3)]">No tiles open.</div>
        )}
        {groups.map(({ frame, items }) => {
          const gid = frame?.id ?? "__loose__";
          const isCollapsed = collapsed.has(gid);
          return (
            <div key={gid} className="mb-0.5">
              <div className="flex items-center gap-1 px-1.5 py-1">
                <button
                  onClick={() => toggleGroup(gid)}
                  className="size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
                  aria-label={isCollapsed ? "expand" : "collapse"}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button
                  onClick={() => frame && onFocusFrame(frame.id)}
                  className="flex-1 flex items-center gap-1.5 min-w-0 text-left text-[11px] font-medium text-[var(--color-fg)] hover:text-[var(--color-fg)]"
                  title={frame ? `Focus ${frame.title}` : "Loose tiles (no frame)"}
                  disabled={!frame}
                >
                  {frame ? (
                    <Square size={9} fill={frame.color} stroke={frame.color} className="shrink-0" />
                  ) : (
                    <span aria-hidden className="size-2 shrink-0 rounded-[2px] border border-[var(--color-line2)]" />
                  )}
                  <span className="truncate">{frame ? frame.title : "Canvas"}</span>
                  <span className="ml-auto font-mono text-[10px] text-[var(--color-fg3)]">{items.length}</span>
                </button>
              </div>
              {!isCollapsed && items.map((t) => {
                const st = status.get(t.id) ?? "idle";
                const sel = t.id === selectedTileId;
                return (
                  <button
                    key={t.id}
                    onClick={() => onFocusTile(t.id)}
                    className={`w-full flex items-center gap-2 pl-7 pr-2 py-1 text-left rounded-sm ${
                      sel ? "bg-[var(--color-bg4)] text-[var(--color-fg)]" : "text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
                    }`}
                    title={`${t.name} · ${st}`}
                  >
                    <span aria-hidden className="w-3.5 shrink-0 text-center font-mono text-[10px] text-[var(--color-fg3)]">
                      {KIND_GLYPH[t.kind]}
                    </span>
                    <span className="truncate flex-1">{t.name}</span>
                    <span
                      aria-hidden
                      className="size-1.5 rounded-full shrink-0"
                      style={{ background: STATUS_COLOR[st] }}
                      title={st}
                    />
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
