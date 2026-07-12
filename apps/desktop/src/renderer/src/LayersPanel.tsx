/**
 * LayersPanel — a DOCKED side panel (t3code / VS Code style) on the left of the
 * canvas. It is a flex SIBLING of the canvas (not an overlay), so the canvas
 * sits beside it and is never occluded. Lists every open tile GROUPED BY FRAME
 * (workspace), each with a live status dot and click-to-focus. Collapsible per
 * group, resizable by its right edge, and collapsible to a narrow icon rail.
 *
 * It reads the same `agent-status-bus` that drives the frame-header chips, so a
 * tile's status here stays in sync with everywhere else. Pure presentational +
 * its own status subscription; Canvas owns the data + focus actions.
 */
import { useEffect, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { Layers, ChevronRight, ChevronDown, GitBranch, Server, Folder, FolderOpen, PanelLeftClose, Globe } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";
import { AgentIcon } from "./agents";

export type LayerKind = "claude" | "terminal" | "editor" | "diff" | "issues" | "browser" | "planReview" | "workbench";

export interface LayerTile {
  id: string;
  kind: LayerKind;
  name: string;
  /** Frame id this tile belongs to, or null when loose on the canvas. */
  frameId: string | null;
  /** For agent tiles (kind "claude"): the registry agent id (claude/codex/…)
   *  so the right logo shows even though they share the agent-terminal kind. */
  agent?: string;
}

export interface LayerFrame {
  id: string;
  title: string;
  color: string;
  /** Set => this is a worktree sub-frame nested under parentFrameId. */
  parentFrameId?: string;
  /** Branch of a worktree sub-frame (shown as a muted tag). */
  branch?: string;
  /** True => bound to a remote SSH host (shown with a Server glyph). */
  remote?: boolean;
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
  plan_review: "var(--color-warn)",
  awaiting_approval: "var(--color-warn)",
};

/** Short pill label per status. */
const STATUS_LABEL: Record<TileStatusKind, string> = {
  working: "working",
  idle: "idle",
  blocked: "blocked",
  permission: "needs you",
  question: "needs you",
  exited: "exited",
  plan_review: "waiting: review",
  awaiting_approval: "waiting: approval",
};

/** Priority for aggregating a frame's child statuses into one dot (t3code-style:
 *  a collapsed frame still shows its highest-priority state). needs-you wins. */
const STATUS_RANK: Record<TileStatusKind, number> = {
  blocked: 3, permission: 3, question: 3, plan_review: 3, awaiting_approval: 3,
  working: 2, exited: 1, idle: 0,
};
const NEEDS_YOU = (s: TileStatusKind | null): boolean =>
  s === "blocked" || s === "permission" || s === "question" || s === "plan_review" || s === "awaiting_approval";

const KIND_GLYPH: Record<LayerKind, string> = {
  claude: "✦",
  terminal: "›_",
  editor: "{}",
  diff: "±",
  issues: "◔",
  // NOT the 🌐 emoji: the OS renders emoji in its own colour, so the browser row
  // was the one blue glyph in a column of monochrome ones — colour implying a
  // meaning that doesn't exist. A lucide icon inherits currentColor like the rest.
  browser: "",
  planReview: "▤",
  workbench: "▥",
};

/** Workspace identity glyph, keyed to the frame color — no boxed chip (the solid
 *  square read as an ugly block). A repo frame is a FOLDER that opens/closes with
 *  the group (semantic: a workspace IS a folder); a worktree is a branch glyph, a
 *  remote is a server glyph. All three are the same size + tinted the frame color,
 *  so the kinds read as one family. */
/**
 * Identity color, turned DOWN. A frame's hue says "which repo"; the status pill
 * says "this agent needs you". Rendered at full chroma they shout at the same
 * volume, and a row of saturated folders reads as decoration the eye must sort
 * through before it finds the one thing that's actually urgent.
 *
 * So the panel mutes the hue toward the tertiary text color: the repo stays
 * distinguishable at a glance, but status is unambiguously the loudest thing on
 * screen. The CANVAS frame headers keep full chroma — that's where the hue earns
 * its keep, separating workspaces across a wide board.
 *
 * `color-mix` (not a chroma tweak in frame-color.ts) because `color` may be an
 * oklch() string, a user-picked hex from the header swatch, OR the legacy
 * `var(--color-brand)` — mixing handles all three without parsing any of them.
 */
const muted = (color: string) => `color-mix(in oklab, ${color} 62%, var(--color-fg3))`;

function WorkspaceIcon({ color, remote, worktree, collapsed }: { color: string; remote?: boolean; worktree: boolean; collapsed: boolean }) {
  const c = muted(color);
  if (remote) return <Server size={15} className="shrink-0" style={{ color: c }} />;
  if (worktree) return <GitBranch size={15} className="shrink-0" style={{ color: c }} />;
  const Icon = collapsed ? Folder : FolderOpen;
  // Outline + a wash of fill, rather than a solid slug of color: the shape still
  // reads as a folder and the hue still identifies it, at a fraction of the ink.
  // `fill` goes through `style`, not the SVG attribute — an attribute parses as
  // an SVG <paint>, which doesn't accept color-mix()/var().
  return (
    <Icon
      size={15}
      className="shrink-0"
      style={{ color: c, fill: `color-mix(in oklab, ${color} 22%, transparent)` }}
    />
  );
}

export function LayersPanel({ frames, tiles, selectedTileId, onFocusTile, onFocusFrame }: Props) {
  // Persisted: panel hidden + which frame groups are collapsed. Now that the
  // panel is DOCKED (a flex sibling, not an overlay) it no longer occludes any
  // tile, so it defaults to SHOWN; collapsing leaves a narrow icon rail. The
  // choice persists ("1" = collapsed to the rail).
  const [hidden, setHidden] = useState<boolean>(
    () => localStorage.getItem("hivemind:layers-hidden") === "1",
  );
  useEffect(() => { localStorage.setItem("hivemind:layers-hidden", hidden ? "1" : "0"); }, [hidden]);
  // Docked-sidebar width, resizable via the right-edge handle (persisted).
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("hivemind:layers-width"));
    return v >= 180 && v <= 480 ? v : 250;
  });
  useEffect(() => { localStorage.setItem("hivemind:layers-width", String(width)); }, [width]);
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => setWidth(Math.max(180, Math.min(480, startW + (ev.clientX - startX))));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
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
    if (t.kind === "planReview") return true; // a blocked agent is waiting on your review
    return NEEDS_YOU(status.get(t.id) ?? null);
  }).length;
  const working = tiles.filter((t) => status.get(t.id) === "working").length;

  // Collapsed → just a small FLOATING icon button (no full-height rail), so the
  // canvas goes edge-to-edge. Absolutely positioned over the canvas's top-left,
  // so it takes no flex width. A status dot rides the icon so a hidden panel
  // still signals "an agent needs you" / "busy".
  if (hidden) {
    const badge = needsYou > 0 ? "var(--color-warn)" : working > 0 ? "var(--color-brand)" : null;
    return (
      <button
        onClick={() => setHidden(false)}
        className="pointer-events-auto absolute left-2.5 top-2.5 z-30 size-8 grid place-items-center rounded-lg hm-island text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
        title={
          needsYou > 0 ? `Show layers (⌘L) — ${needsYou} agent(s) need you`
          : working > 0 ? `Show layers (⌘L) — ${working} working`
          : "Show layers (⌘L)"
        }
        aria-label="show layers"
      >
        <Layers size={16} />
        {badge && (
          <span
            aria-hidden
            className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--color-bg)] ${needsYou > 0 ? "animate-pulse" : ""}`}
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

  // Highest-priority status across a frame's tiles + descendant frames — drives
  // the per-frame status dot, so a COLLAPSED frame still signals "an agent here
  // needs you / is working" (t3code-style aggregate dot). null → all idle.
  const frameAgg = (fid: string): TileStatusKind | null => {
    let best: TileStatusKind | null = null;
    let bestRank = -1;
    const consider = (s: TileStatusKind) => {
      const r = STATUS_RANK[s] ?? 0;
      if (r > bestRank) { bestRank = r; best = s; }
    };
    for (const t of tilesOf(fid)) consider(t.kind === "planReview" ? "question" : (status.get(t.id) ?? "idle"));
    for (const k of childFramesOf(fid)) { const s = frameAgg(k.id); if (s) consider(s); }
    return best;
  };

  const renderTile = (t: LayerTile, depth: number): ReactNode => {
    // A plan-review tile is inherently a "needs you" state (an agent is blocked
    // on your review) — surface it as warn + pulse with a "review" tag.
    const isPlan = t.kind === "planReview";
    const st: TileStatusKind = isPlan ? "question" : (status.get(t.id) ?? "idle");
    const sel = t.id === selectedTileId;
    return (
      <button
        key={t.id}
        onClick={() => onFocusTile(t.id)}
        data-active={sel}
        style={{
          paddingLeft: 12 + depth * 14,
          // Selected surface set INLINE (staleness-proof, glass never remaps it):
          // `--surface-4` is the opaque neutral "active" surface — the SOLE
          // selection cue. No brand accent bar: the inset lavender-blue boxShadow
          // read as an unwanted blue block on the row's left edge. A row is
          // SELECTED, not "focused" — `outline-none` (an already-compiled utility
          // the whole app uses) suppresses the global focus ring.
          ...(sel
            ? {
                background: "var(--surface-4)",
                // Neutral (NOT brand) hairline ring so the active row reads as a
                // distinct card at a glance — the earlier blue accent bar is gone.
                boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 12%, transparent)",
              }
            : {}),
        }}
        // `w-full min-w-0` is load-bearing, not cosmetic: a <button> defaults to
        // width:auto, which on a flex container resolves to FIT-CONTENT. Without
        // it the row shrink-wraps its text — so the selected background hugged the
        // label instead of spanning the row, and the `truncate` on the name below
        // never engaged (the row grew past the panel instead of clipping).
        className={`group flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2.5 pr-2.5 mx-2 text-left rounded-lg outline-none focus-visible:outline-none transition-colors ${
          sel
            ? "text-[var(--color-fg)]"
            : "text-[var(--color-fg2)] hover:bg-[var(--surface-3)] hover:text-[var(--color-fg)]"
        }`}
        title={`${t.name} · ${st}`}
      >
        <span aria-hidden className="w-4 shrink-0 grid place-items-center font-mono text-[11px] text-[var(--color-fg3)]">
          {t.kind === "claude"
            ? <AgentIcon id={t.agent ?? "claude"} size={14} />
            : t.kind === "browser"
              ? <Globe size={12} aria-hidden />
              : KIND_GLYPH[t.kind]}
        </span>
        {/* Name first, so every row's text starts at the same x. The badge used to
            lead, which pushed each name right by however wide its status happened
            to be — the column read as ragged even though nothing was misaligned. */}
        <span className="truncate flex-1 min-w-0">{t.name}</span>
        {/* A word is for something you must ACT on. `working` is an agent doing its
            job — the ordinary case — so it gets a dot, not a label: present enough
            to see at a glance, quiet enough that `approve?` / `blocked` are the only
            words in the column and therefore impossible to miss. Only those pulse.
            (TerminalTile already said as much: "pulsing every active state is the
            slop tell.") `exited` keeps its word — a dead tile is worth reading. */}
        {st === "working" ? (
          <span
            aria-label="working"
            title="working"
            className="shrink-0 ml-auto size-1.5 rounded-full"
            style={{ background: STATUS_COLOR[st] }}
          />
        ) : st !== "idle" ? (
          <span
            className={`shrink-0 ml-auto text-[10px] font-medium leading-none px-1.5 py-[3px] rounded-full ${NEEDS_YOU(st) ? "animate-pulse" : ""}`}
            style={{ color: STATUS_COLOR[st], background: `color-mix(in srgb, ${STATUS_COLOR[st]} 16%, transparent)` }}
            title={st}
          >
            {isPlan ? "review" : STATUS_LABEL[st]}
          </span>
        ) : null}
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
    const agg = frameAgg(gid);
    return (
      <div key={gid} className={depth === 0 ? "mt-1.5 first:mt-1" : ""}>
        <div className="group/grp flex items-center gap-0.5 h-8 pr-2 mx-2 rounded-lg hover:bg-[var(--color-bg3)] transition-colors" style={{ paddingLeft: depth * 14 }}>
          <button
            onClick={() => toggleGroup(gid)}
            className="size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)]"
            aria-label={isCollapsed ? "expand" : "collapse"}
          >
            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            onClick={() => onFocusFrame(frame.id)}
            className="flex-1 flex items-center gap-2 min-w-0 text-left text-[14px] font-semibold tracking-[-0.014em] text-[var(--color-fg)]"
            title={isWt ? `Focus worktree ${frame.branch ?? frame.title}` : `Focus ${frame.title}`}
          >
            <WorkspaceIcon color={frame.color} remote={frame.remote} worktree={isWt} collapsed={isCollapsed} />
            <span className="truncate">{frame.title}</span>
            <span className="ml-auto flex items-center gap-1.5 min-w-0">
              {/* The frame's aggregate is a SUMMARY of its children. While the group
                  is expanded the children are right there saying it themselves, so
                  repeating it on the parent is the same fact twice — the row read
                  `hmdemo working` directly above `Claude Code working`. Summarise
                  only what's hidden: when collapsed, or when a child needs a human
                  (that one is worth shouting even with the row open). */}
              {agg && agg !== "idle" && agg !== "exited" && (isCollapsed || NEEDS_YOU(agg)) && (
                NEEDS_YOU(agg) ? (
                  <span
                    className="shrink-0 text-[9px] font-medium leading-none px-1.5 py-[3px] rounded-full animate-pulse"
                    style={{ color: STATUS_COLOR[agg], background: `color-mix(in srgb, ${STATUS_COLOR[agg]} 16%, transparent)` }}
                    title={STATUS_LABEL[agg]}
                  >
                    {STATUS_LABEL[agg]}
                  </span>
                ) : (
                  <span
                    aria-label={STATUS_LABEL[agg]}
                    title={STATUS_LABEL[agg]}
                    className="shrink-0 size-1.5 rounded-full"
                    style={{ background: STATUS_COLOR[agg] }}
                  />
                )
              )}
              {/* A frame with nothing in it shouldn't advertise a `0` — an empty
                  count is noise the eye still has to read and discard. */}
              {items.length + kids.length > 0 && (
                <span className="font-mono text-[11px] tabular-nums text-[var(--color-fg3)] shrink-0">
                  {items.length + kids.length}
                </span>
              )}
            </span>
          </button>
        </div>
        {!isCollapsed && (items.length > 0 || kids.length > 0) && (
          // Nesting guide rail — a faint vertical line the child rows hang from,
          // aligned under this group's workspace chip, so the worktree/tile
          // hierarchy reads at a glance instead of relying on indent alone.
          <div className="relative">
            <span
              aria-hidden
              className="absolute top-0 bottom-1 w-px bg-[var(--color-line)]"
              style={{ left: depth * 14 + 18 }}
            />
            {items.map((t) => renderTile(t, depth + 1))}
            {kids.map((k) => renderFrameGroup(k, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="hm-layers relative h-full shrink-0 flex flex-col bg-[var(--color-bg2)] border-r border-[var(--color-line)] overflow-hidden"
      style={{ width }}
      aria-label="Layers"
    >
      <header className="flex items-center gap-2 px-3 h-11 text-[13px] font-semibold text-[var(--color-fg2)]">
        <Layers size={14} className="text-[var(--color-fg3)]" />
        <span>Layers</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
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
        <kbd
          aria-hidden
          title="Toggle the Layers panel"
          className="grid place-items-center h-[15px] px-1 rounded bg-[var(--color-bg)] border border-[var(--color-line2)] text-[9px] font-mono text-[var(--color-fg3)] tracking-tight"
        >⌘L</kbd>
        <button
          onClick={() => setHidden(true)}
          className="size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          title="Collapse layers (⌘L)"
          aria-label="collapse layers"
        ><PanelLeftClose size={14} /></button>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain pb-2 text-[14px]">
        {totalGroups === 0 && (
          <div className="px-3 py-2 text-[12px] text-[var(--color-fg3)]">No tiles open.</div>
        )}
        {topFrames.map((f) => renderFrameGroup(f, 0))}
        {looseTiles.length > 0 && (
          <div className="mt-1.5">
            <div className="flex items-center gap-2 h-8 pr-2 mx-2 pl-[26px]">
              <span className="flex-1 flex items-center gap-2 min-w-0 text-[14px] font-medium text-[var(--color-fg2)]">
                <FolderOpen size={15} aria-hidden className="shrink-0 text-[var(--color-fg3)]" />
                <span className="truncate">Canvas</span>
                <span className="ml-auto font-mono text-[11px] text-[var(--color-fg3)]">{looseTiles.length}</span>
              </span>
            </div>
            {looseTiles.map((t) => renderTile(t, 1))}
          </div>
        )}
      </div>
      {/* Right-edge resize grip (t3code-style) — drag to set the panel width. */}
      <div
        onPointerDown={startResize}
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[var(--color-brand)] active:bg-[var(--color-brand)] opacity-0 hover:opacity-60"
        title="Drag to resize"
        aria-hidden
      />
    </aside>
  );
}
