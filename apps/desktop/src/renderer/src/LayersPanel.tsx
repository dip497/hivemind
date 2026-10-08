/**
 * LayersPanel — a DOCKED side panel on the left of the canvas, a flex SIBLING of it (never an
 * overlay). Lists every open tile: the pinned ones first, then the rest as its View menu says —
 * which (status, last activity, machine), grouped how (machine, group, date, status, agent, none)
 * and in what order. What it lists is worked out by layers-model.ts; this draws it.
 *
 * The View menu is the person's, for every workspace (settings `views.layers`); pins and folded
 * groups are theirs for this workspace on this device (a personal layout), never the shared
 * document, so pinning in a shared workspace moves no one else's rows.
 */
import { statusColor } from "./workspace/tile-status-bucket";
import { MachineDot, statusWords } from "./machines/status";
import { A_DEVICE, GONE_MACHINE, openMachines, placeOf, statusOf, useMachines } from "./machines/store";
import type { MachineInfo } from "../../shared/ipc";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { Layers, ChevronRight, ChevronDown, GitBranch, Server, Folder, FolderOpen, PanelLeftClose, Plus, RefreshCw, Ellipsis, EllipsisVertical, X, Pencil, Trash, Pin, PinOff, Search, Bell, SquarePen, FolderPlus, Shapes, Blocks, History, Mail, MailOpen, AlarmClock, AlarmClockOff } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "./agent-status-bus";
import { AgentIcon, agentById, useAgents } from "./agents";
import { notReady, useAgentPresence } from "./agent-plugins";
import { preferredAgent } from "@hivemind/agents";
import { FrameMenu, type FrameActions } from "./FrameMenu";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { AGENT_TILE_KIND } from "./tile-kinds";
import { tileKind } from "./tiles";
import { KindMark } from "./tiles/mark";
import { MenuItem } from "./components/ui/menu-item";
import { isUnread, layersView, recentsView, type ModelTile, type RecentSession } from "@hivemind/core/layers";
import type { WorkspaceSummary } from "../../shared/ipc";
import { useSettings, patchSettings } from "./settings-store";
import { setPanelOrder } from "./workspace/panel-order";
import { useViewLayout } from "./workspace/view-layout-store";
import { DEFAULT_LAYERS_PREFS, type LayersPrefs } from "@hivemind/core/settings-schema";

/** The tile's kind, as its plugin registered it. */
export type LayerKind = string;

export interface LayerTile {
  id: string;
  kind: LayerKind;
  name: string;
  /** Frame id this tile belongs to, or null when loose on the canvas. */
  frameId: string | null;
  /** For agent tiles (kind AGENT_TILE_KIND): the registry agent id (claude/codex/…)
   *  so the right logo shows even though they share the agent-terminal kind. */
  agent?: string;
  /** The tile that started it, when an agent did: it is listed under that one. */
  parent?: string;
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
  /** Its ssh:// uri, so the glyph can show the machine's link state. */
  remoteUri?: string;
  /** Name of the folder it is bound to, shown when it differs from the title. */
  folder?: string;
  /** Its folder on this computer, when it is on this computer: where its agents' past sessions are. */
  path?: string;
}

interface Props {
  frames: LayerFrame[];
  tiles: LayerTile[];
  selectedTileId: string | null;
  onFocusTile: (id: string) => void;
  onFocusFrame: (id: string) => void;
  /** The workspace's layout key: where this person's pins and folded groups are kept. */
  layoutKey?: string | null;
  /** Shown beside the canvas: a frame's menu offers Arrange, which places its tiles there. */
  canvas?: boolean;
  /** The workspace's own folder on this computer: where tiles in a frame with no folder run. */
  folder?: string | null;
  /** Start an agent again on one of its past sessions, in the frame of that session's folder. */
  onResume?: (agent: string, frameId: string | null, session: string) => void;
  /** When provided, right-clicking a frame row opens a context menu that
   *  mirrors the frame header (spawn agent/tile, worktree, workspace, remote,
   *  arrange, rename/color/delete). Optional so the panel still renders without
   *  a host that wires these (e.g. tests). */
  frameActions?: FrameActions;
  /** Per-tile actions (close / rename) from the view's commands. Optional the
   *  same way frameActions is: a host without them just hides the × and the
   *  tile menu's actions. */
  tileActions?: {
    onClose: (id: string) => void;
    onRename: (id: string, name: string) => void;
  };
}

// One status, one colour, shared with every other surface (workspace/tile-status-bucket).
const STATUS_COLOR = Object.fromEntries(
  (["working", "idle", "blocked", "permission", "question", "exited", "plan_review", "awaiting_approval"] as const)
    .map((k) => [k, statusColor(k)]),
) as Record<TileStatusKind, string>;

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

/**
 * The panel's one type and icon scale: the title 15px semibold; a row (an action, a group, a tile)
 * 14px, its leading mark in a 16px box drawn at a 1.75 stroke; a section label 12px medium in
 * sentence case; counts and times 11px. Labels and counts use --color-fg2: --color-fg3 is under
 * 4.5:1 on the panel (see .u-eyebrow).
 */
const ICON = 16;
/** The key that jumps to a row with its number: ⌘ on macOS, Ctrl elsewhere. */
const MOD = typeof window !== "undefined" && window.hive?.platform === "darwin" ? "⌘" : "Ctrl ";
const STROKE = 1.5;
const LABEL = "text-[12px] font-medium text-[var(--color-fg2)]";
const COUNT = "text-[11px] tabular-nums text-[var(--color-fg2)]";

/** This person's own for this workspace: pinned tiles (in pin order), the groups they folded, when
 *  they last looked at each tile, and the tiles they snoozed, until when. */
interface Mine { pinned: string[]; collapsed: string[]; seen?: Record<string, number>; snoozed?: Record<string, number> }
const MINE = { viewId: "layers", version: 1, initial: (): Mine => ({ pinned: [], collapsed: [], seen: {}, snoozed: {} }), personal: true } as const;

/** Snooze choices: until when, from now. */
const SNOOZES: Array<[string, (now: number) => number]> = [
  ["30 minutes", (n) => n + 30 * 60_000],
  ["1 hour", (n) => n + 60 * 60_000],
  ["2 hours", (n) => n + 120 * 60_000],
  ["Tomorrow at 9:00", (n) => { const d = new Date(n); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime(); }],
];
const timeOf = (ms: number, now: number) => {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
};

/** The View menu's choices, in its words. */
const VIEW_CHOICES = {
  status: [["all", "All"], ["needs-you", "Needs you"], ["unread", "Unread"], ["working", "Working"], ["idle", "Idle"], ["exited", "Exited"]],
  activity: [["all", "All"], ["hour", "Past hour"], ["today", "Today"], ["week", "This week"]],
  groupBy: [["machine", "Machine"], ["group", "Group"], ["date", "Date"], ["status", "Status"], ["agent", "Agent"], ["none", "None"]],
  sortBy: [["canvas", "Canvas order"], ["activity", "Last activity"], ["name", "Name"]],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;
const choiceLabel = <K extends keyof typeof VIEW_CHOICES>(k: K, v: string) => (VIEW_CHOICES[k] as ReadonlyArray<readonly [string, string]>).find(([id]) => id === v)?.[1] ?? v;

/** "now", "4m ago", "3h ago", "2d ago". */
function ago(t: number | null, now: number): string {
  if (t === null) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Identity color, turned DOWN: the frame's hue says "which repo", the status pill says "this
 * agent needs you"; at full chroma they shout at the same volume. `color-mix` because `color` may
 * be an oklch() string or a user-picked hex.
 */
const muted = (color: string) => `color-mix(in oklab, ${color} 62%, var(--color-fg3))`;

function RemoteIcon({ color, uri }: { color: string; uri?: string }) {
  const snap = useMachines();
  const { machine, device, hostId } = placeOf(snap, uri);
  const s = statusOf(snap, hostId);
  return (
    <span className="relative shrink-0 grid place-items-center" title={machine?.label ?? device?.name ?? hostId ?? GONE_MACHINE}>
      <Server size={ICON} strokeWidth={STROKE} style={{ color: muted(color) }} />
      {s.state !== "idle" && <span className="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-[var(--color-bg2)] leading-[0]"><MachineDot status={s} size={6} /></span>}
    </span>
  );
}

function WorkspaceIcon({ color, remote, remoteUri, worktree, collapsed }: { color: string; remote?: boolean; remoteUri?: string; worktree: boolean; collapsed: boolean }) {
  const c = muted(color);
  if (remote) return <RemoteIcon color={color} uri={remoteUri} />;
  if (worktree) return <GitBranch size={ICON} strokeWidth={STROKE} className="shrink-0" style={{ color: c }} />;
  const Icon = collapsed ? Folder : FolderOpen;
  // `fill` through `style`: an SVG attribute does not accept color-mix()/var().
  return <Icon size={ICON} strokeWidth={STROKE} className="shrink-0" style={{ color: c, fill: `color-mix(in oklab, ${color} 22%, transparent)` }} />;
}

/** What a tile row needs from the panel; stable across renders, so a row redraws only when its own tile does. */
interface RowActions {
  focus: (id: string) => void;
  menu: (t: ModelTile, at: { x: number; y: number }) => void;
  hover: (t: ModelTile | null, el?: HTMLElement) => void;
  /** Fold or unfold the tiles it started. */
  fold: (id: string) => void;
  close?: (id: string) => void;
}

/** One tile's row: its mark, its name, and its status when that is worth reading. */
const TileRow = memo(function TileRow({ t, depth, selected, actions, started = 0, folded = false, jumpKey, until }: { t: ModelTile; depth: number; selected: boolean; actions: RowActions; started?: number; folded?: boolean; jumpKey?: number; until?: string }) {
  const st = t.status;
  const unread = isUnread(t);
  const isPlan = !!tileKind(t.kind).waitsOnPerson;
  return (
    <div
      role="button"
      aria-label={t.name}
      tabIndex={0}
      onClick={() => actions.focus(t.id)}
      onKeyDown={(e) => { if (e.key === "Enter") actions.focus(t.id); }}
      onContextMenu={(e) => { e.preventDefault(); actions.menu(t, { x: e.clientX, y: e.clientY }); }}
      onMouseEnter={(e) => actions.hover(t, e.currentTarget)}
      onMouseLeave={() => actions.hover(null)}
      data-active={selected}
      data-layer-tile={t.id}
      aria-expanded={started ? !folded : undefined}
      style={{
        paddingLeft: 12 + depth * 14,
        ...(selected ? { background: "var(--surface-4)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-fg) 12%, transparent)" } : {}),
      }}
      // `w-[calc(100%-1rem)] min-w-0`: without a width the row shrink-wraps its text and `truncate` never engages.
      className={`group relative flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2.5 pr-1.5 mx-2 text-left rounded-lg outline-none focus-visible:outline-none cursor-pointer transition-colors ${
        selected ? "text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--surface-3)]"
      }`}
    >
      {/* What it started folds under it: the chevron sits in the indent, left of its mark. */}
      {started > 0 && (
        <button type="button" data-layer-fold={t.id} aria-label={`${folded ? "Show" : "Hide"} the ${started} it started`}
          onClick={(e) => { e.stopPropagation(); actions.fold(t.id); }}
          className="absolute top-1/2 -translate-y-1/2 grid size-4 place-items-center rounded text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
          style={{ left: depth * 14 - 4 }}>
          {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
      <span aria-hidden className="size-4 shrink-0 grid place-items-center text-[var(--color-fg2)]">
        {t.kind === AGENT_TILE_KIND ? <AgentIcon id={t.agent} size={ICON - 1} /> : <KindMark kind={t.kind} size={ICON} />}
      </span>
      {/* Name first, so every row's text starts at the same x. Unread: its name in weight. */}
      <span className={`truncate flex-1 min-w-0 ${unread ? "font-semibold" : ""}`} data-layer-unread={unread ? "" : undefined} title={unread ? "Done since you last looked" : undefined}>{t.name}</span>
      {/* While Ctrl/⌘ is held: the number that jumps here, in place of its status. */}
      {jumpKey !== undefined ? (
        <kbd data-layer-jump={jumpKey} className="grid min-w-[18px] h-[18px] shrink-0 place-items-center rounded-[5px] px-1 font-sans text-[11px] leading-none tabular-nums text-[var(--color-fg2)] shadow-[inset_0_0_0_1px_var(--color-line2)]">
          {MOD}{jumpKey}
        </kbd>
      ) : /* A word only for what you must act on; `working` is a dot. Only needs-you pulses. */ st === "working" ? (
        <span aria-label="working" title="working" className="shrink-0 size-1.5 rounded-full group-hover:hidden" style={{ background: STATUS_COLOR[st] }} />
      ) : until ? (
        <span className={`shrink-0 ${COUNT} group-hover:hidden`} data-layer-until>{until}</span>
      ) : st !== "idle" ? (
        <span
          className={`shrink-0 text-[10px] font-medium leading-none px-1.5 py-[3px] rounded-full ${NEEDS_YOU(st) ? "animate-pulse" : "group-hover:hidden"}`}
          style={{ color: STATUS_COLOR[st], background: `color-mix(in srgb, ${STATUS_COLOR[st]} 16%, transparent)` }}
          title={st}
        >
          {isPlan ? "review" : STATUS_LABEL[st]}
        </span>
      ) : unread ? (
        <span aria-label="unread" title="Done since you last looked" className="shrink-0 size-2 rounded-full bg-[var(--color-brand)] group-hover:hidden" />
      ) : null}
      {actions.close && (st === "working" || st === "exited") && (
        <Button variant="ghost" size="icon-2xs" reveal="hidden" onClick={(e) => { e.stopPropagation(); actions.close!(t.id); }} title={`Close ${t.name}`} aria-label={`Close ${t.name}`}>
          <X size={12} />
        </Button>
      )}
      <Button variant="ghost" size="icon-2xs" reveal="hidden" aria-label={`${t.name} actions`} data-layer-tile-menu
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); actions.menu(t, { x: r.right, y: r.bottom }); }}>
        <EllipsisVertical size={12} />
      </Button>
    </div>
  );
});

// Memo: a child of the canvas view, which re-renders on every drag frame.
export const LayersPanel = memo(function LayersPanel({ frames, tiles, selectedTileId, onFocusTile, onFocusFrame, layoutKey = null, canvas = false, folder = null, onResume, frameActions, tileActions }: Props) {
  // Before the early `hidden` return: hooks run on every render, in the same order.
  const machineSnap = useMachines();
  const prefs = useSettings().views.layers;
  const [mine, setMine] = useViewLayout<Mine>(MINE, layoutKey);
  const pinnedSet = useMemo(() => new Set(mine.pinned), [mine.pinned]);
  const collapsed = useMemo(() => new Set(mine.collapsed), [mine.collapsed]);
  // Persisted: panel hidden (collapsed to the floating button) and its width.
  const [hidden, setHidden] = useState<boolean>(() => localStorage.getItem("hivemind:layers-hidden") === "1");
  useEffect(() => { localStorage.setItem("hivemind:layers-hidden", hidden ? "1" : "0"); }, [hidden]);
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
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // ⌘/Ctrl+B toggles the panel (App's menu bridge; works over a focused terminal too).
  useEffect(() => {
    const onToggle = () => setHidden((h) => !h);
    window.addEventListener("hivemind:toggle-layers", onToggle);
    return () => window.removeEventListener("hivemind:toggle-layers", onToggle);
  }, []);
  // Right-click-a-frame context menu (only when a host wired frameActions).
  const [menu, setMenu] = useState<{ frame: LayerFrame; x: number; y: number } | null>(null);
  const [tileMenu, setTileMenu] = useState<{ tile: ModelTile; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [renamingTile, setRenamingTile] = useState<{ id: string; draft: string } | null>(null);
  const [card, setCard] = useState<{ tile: ModelTile; top: number; left: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [closingLoose, setClosingLoose] = useState(false);
  const [query, setQuery] = useState("");
  // Projects: every workspace here, as main counts it; read again as statuses change.
  const [projects, setProjects] = useState<WorkspaceSummary[]>([]);
  // Recents: this workspace's past agent sessions, read once its folders are known.
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [recentLimit, setRecentLimit] = useState(5);
  const cardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live status per tile, and when it last changed: seeded from main's ledger (it outlives a
  // reload), then each change. The bus replays every status on subscribe; that is no activity.
  const [status, setStatus] = useState<Map<string, TileStatusKind>>(new Map());
  const [activity, setActivity] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    let live = true;
    void window.hive.viewLedgerSnapshot().then((lines) => {
      if (!live) return;
      setActivity((m) => {
        const next = new Map(m);
        for (const l of lines) if (!next.has(l.id)) next.set(l.id, l.since);
        return next;
      });
    }, () => {});
    let replaying = true;
    const off = subscribeStatus((e) => {
      setStatus((m) => {
        if (m.get(e.tileId) === e.status) return m;
        const next = new Map(m);
        next.set(e.tileId, e.status);
        return next;
      });
      if (!replaying) setActivity((m) => new Map(m).set(e.tileId, Date.now()));
    });
    replaying = false;
    return () => { live = false; off(); };
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // What the panel adds to the tiles is never worth the view: a read that fails shows nothing.
    const read = () => void Promise.resolve().then(() => window.hive.workspaceSummaries()).then((list) => { if (live) setProjects(list); }, () => {});
    const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(read, 1500); };
    read();
    let first = true;
    const off = subscribeStatus(() => { if (!first) soon(); });
    first = false;
    window.addEventListener("focus", read);
    return () => { live = false; off(); if (timer) clearTimeout(timer); window.removeEventListener("focus", read); };
  }, []);
  // Every folder an agent here runs in: each frame's, and the workspace's for frames with none.
  const folders = [...new Set([folder, ...frames.map((f) => f.path)].filter((p): p is string => !!p))].join("\n");
  // The agents that keep sessions, read again once the catalog has loaded: it is empty at first.
  const sessionAgents = useAgents().filter((a) => a.enabled && a.def.session).map((a) => a.id).join("\n");
  useEffect(() => {
    let live = true;
    const dirs = folders ? folders.split("\n") : [];
    const agents = sessionAgents ? sessionAgents.split("\n") : [];
    // At most 24 reads, after the first paint: Recents is never what the panel waits on.
    const asks = dirs.flatMap((dir) => agents.map((a) => [a, dir] as const)).slice(0, 24);
    const id = setTimeout(() => {
      void Promise.all(asks.map(([agent, dir]) => Promise.resolve().then(() => window.hive.viewSessions(agent, dir)).then(
        (rows) => rows.map((r): RecentSession => ({ agent, folder: dir, ...r })), () => [] as RecentSession[],
      ))).then((all) => { if (live) setRecents(all.flat()); });
    }, 300);
    return () => { live = false; clearTimeout(id); };
  }, [folders, sessionAgents]);

  // "4m ago" stays true: a tick a minute while the panel is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);

  const toggleGroup = useCallback((id: string) => setMine((m) => ({
    ...m, collapsed: m.collapsed.includes(id) ? m.collapsed.filter((x) => x !== id) : [...m.collapsed, id],
  })), [setMine]);
  const togglePin = useCallback((id: string) => setMine((m) => ({
    ...m, pinned: m.pinned.includes(id) ? m.pinned.filter((x) => x !== id) : [...m.pinned, id],
  })), [setMine]);
  // A closed tile's pin, last look and snooze go with it.
  useEffect(() => {
    const open = new Set(tiles.map((t) => t.id));
    const keep = (r: Record<string, number> = {}) => Object.fromEntries(Object.entries(r).filter(([id]) => open.has(id)));
    const gone = (r: Record<string, number> = {}) => Object.keys(r).some((id) => !open.has(id));
    if (mine.pinned.some((id) => !open.has(id)) || gone(mine.seen) || gone(mine.snoozed)) {
      setMine((m) => ({ ...m, pinned: m.pinned.filter((id) => open.has(id)), seen: keep(m.seen), snoozed: keep(m.snoozed) }));
    }
  }, [tiles, mine.pinned, mine.seen, mine.snoozed, setMine]);
  const setSeen = useCallback((id: string, at: number) => setMine((m) => ({ ...m, seen: { ...m.seen, [id]: at } })), [setMine]);
  const setSnooze = useCallback((id: string, until: number | null) => setMine((m) => {
    const snoozed = { ...m.snoozed };
    if (until === null) delete snoozed[id]; else snoozed[id] = until;
    return { ...m, snoozed };
  }), [setMine]);
  const setPref = (key: keyof LayersPrefs, value: unknown) => patchSettings(`views.layers.${key}`, value);

  // Frame forest: top-level (repo) frames each own their worktree sub-frames.
  const topFrames = frames.filter((f) => !f.parentFrameId || !frames.some((p) => p.id === f.parentFrameId));
  const childFramesOf = (fid: string) => frames.filter((f) => f.parentFrameId === fid);
  // Every saved machine is a group, frames or not, so this rail is where machines live.
  const machineGroups: MachineGroup[] = [{ key: "local", label: "This computer", frames: [] }];
  for (const m of machineSnap.machines) machineGroups.push({ key: m.id, label: m.label, hostId: m.hostId, machine: m, frames: [] });
  const machineOfFrame = new Map<string, string>();
  for (const f of topFrames) {
    const { machine, device, hostId } = placeOf(machineSnap, f.remoteUri);
    const key = !f.remoteUri ? "local" : machine?.id ?? hostId ?? "gone";
    let g = machineGroups.find((x) => x.key === key);
    if (!g) machineGroups.push(g = { key, label: device?.name ?? (hostId?.startsWith("device:") ? A_DEVICE : hostId?.replace(/:22$/, "")) ?? GONE_MACHINE, ...(hostId ? { hostId } : {}), frames: [] });
    g.frames.push(f);
    machineOfFrame.set(f.id, key);
    for (const k of childFramesOf(f.id)) machineOfFrame.set(k.id, key);
  }

  const modelTiles: ModelTile[] = useMemo(() => tiles.map((t) => {
    const waits = !!tileKind(t.kind).waitsOnPerson;
    const st: TileStatusKind = waits ? "question" : (status.get(t.id) ?? "idle");
    return {
      ...t, status: st, needsYou: waits || NEEDS_YOU(st), activity: activity.get(t.id) ?? null, machine: (t.frameId && machineOfFrame.get(t.frameId)) || "local",
      seen: mine.seen?.[t.id] ?? null, ...(mine.snoozed?.[t.id] ? { snoozedUntil: mine.snoozed[t.id] } : {}),
    };
  // machineOfFrame is rebuilt each render from frames + machines; its content is what matters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tiles, status, activity, frames, machineSnap, mine.seen, mine.snoozed]);
  // Seen: a tile new to this person is seen as it appears, so nothing opens unread; the one they
  // have selected is seen as it changes; looking at one wakes it from a snooze.
  useEffect(() => {
    const unseen = modelTiles.filter((t) => mine.seen?.[t.id] === undefined);
    const sel = modelTiles.find((t) => t.id === selectedTileId);
    const selStale = sel && (sel.seen ?? 0) < (sel.activity ?? 0);
    if (!unseen.length && !selStale && !(sel && mine.snoozed?.[sel.id])) return;
    setMine((m) => {
      const seen = { ...m.seen };
      const at = Date.now();
      for (const t of unseen) seen[t.id] = t.activity ?? at;
      if (sel) seen[sel.id] = Math.max(at, sel.activity ?? 0);
      const snoozed = { ...m.snoozed };
      if (sel) delete snoozed[sel.id];
      return { ...m, seen, snoozed };
    });
  }, [modelTiles, selectedTileId, mine.seen, mine.snoozed, setMine]);
  const agentLabel = (t: ModelTile) => (t.kind === AGENT_TILE_KIND ? agentById(t.agent)?.label ?? t.agent ?? "Agent" : tileKind(t.kind).title ?? "Other");
  const view = layersView({ tiles: modelTiles, pinned: mine.pinned, prefs, now, agentLabel, query });
  const recentRows = recentsView(recents, { limit: recentLimit, query, agentLabel: (a) => agentById(a)?.label ?? a });

  const needsYou = modelTiles.filter((t) => t.needsYou).length;
  const working = modelTiles.filter((t) => t.status === "working" && !t.needsYou).length;

  // The bell: each press goes to the next tile that needs you, in the order they are listed.
  const nextAt = useRef(0);
  const nextNeedsYou = () => {
    const waiting = modelTiles.filter((t) => t.needsYou);
    if (!waiting.length) return;
    const t = waiting[nextAt.current++ % waiting.length]!;
    onFocusTile(t.id);
  };
  const title = layoutKey?.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";

  // Rows call these; kept stable so a row redraws only when its own tile changes.
  const focusRef = useRef(onFocusTile);
  focusRef.current = onFocusTile;
  const closeRef = useRef(tileActions?.onClose);
  closeRef.current = tileActions?.onClose;
  const rowActions = useMemo<RowActions>(() => ({
    focus: (id) => focusRef.current(id),
    menu: (tile, at) => { setCard(null); setTileMenu({ tile, ...at }); },
    hover: (tile, el) => {
      if (cardTimer.current) clearTimeout(cardTimer.current);
      if (!tile || !el) { setCard(null); return; }
      cardTimer.current = setTimeout(() => {
        const r = el.getBoundingClientRect();
        const edge = el.closest("aside")?.getBoundingClientRect().right ?? r.right;
        // Beside the panel, level with the row, and never past the bottom of the window.
        setCard({ tile, top: Math.max(8, Math.min(r.top - 6, window.innerHeight - 124)), left: edge + 8 });
      }, 450);
    },
    fold: (id) => toggleGroup(`tile:${id}`),
    ...(tileActions ? { close: (id: string) => closeRef.current?.(id) } : {}),
  }), [!!tileActions, toggleGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  // The rows in the order this render draws them (renderTile fills it): what Ctrl/⌘+1…9 count.
  const drawn = useRef<string[]>([]);
  drawn.current = [];
  useEffect(() => { setPanelOrder(drawn.current); });
  useEffect(() => () => setPanelOrder([]), []);
  // Held a moment, Ctrl or ⌘ numbers the first nine rows; any key or letting go hides them.
  const [numbered, setNumbered] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; setNumbered(false); };
    const down = (e: KeyboardEvent) => {
      if ((e.key === "Control" || e.key === "Meta") && !e.repeat) { stop(); timer = setTimeout(() => setNumbered(true), 400); }
      else if (e.key !== "Control" && e.key !== "Meta") { if (timer) clearTimeout(timer); timer = null; }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", stop, true);
    window.addEventListener("blur", stop);
    return () => { stop(); window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", stop, true); window.removeEventListener("blur", stop); };
  }, []);

  // Collapsed → a small FLOATING button over the canvas's top-left; its dot still says
  // "an agent needs you" / "busy".
  if (hidden) {
    const badge = needsYou > 0 ? "var(--color-warn)" : working > 0 ? "var(--color-brand)" : null;
    return (
      <Button variant="secondary" size="icon" onClick={() => setHidden(false)} className="pointer-events-auto absolute left-2.5 top-2.5 z-30"
        title={needsYou > 0 ? `Show layers (⌘B) — ${needsYou} agent(s) need you` : working > 0 ? `Show layers (⌘B) — ${working} working` : "Show layers (⌘B)"}
        aria-label="show layers">
        <Layers />
        {badge && <span aria-hidden className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--color-bg)] ${needsYou > 0 ? "animate-pulse" : ""}`} style={{ background: badge }} />}
      </Button>
    );
  }

  const shownIn = (fid: string) => view.byFrame.get(fid) ?? [];
  const hasShown = (fid: string): boolean => shownIn(fid).length > 0 || childFramesOf(fid).some((k) => hasShown(k.id));
  // Highest-priority status across a frame's listed tiles + sub-frames (a folded frame still signals).
  const frameAgg = (fid: string): TileStatusKind | null => {
    let best: TileStatusKind | null = null;
    let bestRank = -1;
    for (const t of shownIn(fid)) { const r = STATUS_RANK[t.status] ?? 0; if (r > bestRank) { bestRank = r; best = t.status; } }
    for (const k of childFramesOf(fid)) { const s = frameAgg(k.id); if (s && (STATUS_RANK[s] ?? 0) > bestRank) { bestRank = STATUS_RANK[s] ?? 0; best = s; } }
    return best;
  };
  const needsYouIn = (fid: string): number => shownIn(fid).filter((t) => t.needsYou).length + childFramesOf(fid).reduce((n, k) => n + needsYouIn(k.id), 0);

  const renderTile = (t: ModelTile, depth: number): ReactNode => {
    drawn.current.push(t.id);
    const n = drawn.current.length;
    const key = numbered && n <= 9 ? n : undefined;
    if (renamingTile?.id === t.id) {
      const commit = () => { tileActions?.onRename(t.id, renamingTile.draft); setRenamingTile(null); };
      return (
        <div key={t.id} className="flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2 mx-2" style={{ paddingLeft: 12 + depth * 14 }}>
          <Input autoFocus value={renamingTile.draft} onChange={(e) => setRenamingTile({ id: t.id, draft: e.target.value })} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setRenamingTile(null); e.stopPropagation(); }}
            className="flex-1 min-w-0" aria-label="Rename tile" />
        </div>
      );
    }
    const started = view.kids.get(t.id) ?? [];
    const folded = collapsed.has(`tile:${t.id}`);
    if (!started.length) return <TileRow key={t.id} t={t} depth={depth} selected={t.id === selectedTileId} actions={rowActions} jumpKey={key} />;
    return (
      <div key={t.id} role="group" aria-label={`${t.name} and what it started`} data-layer-started={t.id}>
        <TileRow t={t} depth={depth} selected={t.id === selectedTileId} actions={rowActions} started={started.length} folded={folded} jumpKey={key} />
        {!folded && started.map((k) => renderTile(k, depth + 1))}
      </div>
    );
  };

  // A frame group: header + its listed tiles, then its worktree groups one level deeper. While the
  // View menu leaves tiles out, a frame with none of its own listed is left out too.
  const renderFrameGroup = (frame: LayerFrame, depth: number, groupByMachine: boolean): ReactNode => {
    const gid = frame.id;
    if (view.filtering && !hasShown(gid)) return null;
    const isCollapsed = collapsed.has(gid);
    const items = shownIn(gid);
    const kids = childFramesOf(gid).filter((k) => !view.filtering || hasShown(k.id));
    const isWt = !!frame.parentFrameId;
    const agg = frameAgg(gid);
    const commitRename = () => { const t = renaming?.draft.trim(); if (t) frameActions?.onRename(gid, t); setRenaming(null); };
    return (
      <div key={gid} className={depth === 0 ? "mt-1.5 first:mt-1" : ""}>
        <div data-layers-frame={gid} className="group/grp flex items-center gap-0.5 h-8 pr-2 mx-2 rounded-lg hover:bg-[var(--color-bg3)] transition-colors" style={{ paddingLeft: depth * 14 }}
          onContextMenu={frameActions ? (e) => { e.preventDefault(); setMenu({ frame, x: e.clientX, y: e.clientY }); } : undefined}>
          <Button variant="ghost" size="icon-2xs" onClick={() => toggleGroup(gid)} aria-label={isCollapsed ? "expand" : "collapse"}>
            {isCollapsed ? <ChevronRight size={14} strokeWidth={STROKE} /> : <ChevronDown size={14} strokeWidth={STROKE} />}
          </Button>
          {renaming?.id === gid ? (
            <div className="flex-1 flex items-center gap-2 min-w-0">
              <WorkspaceIcon color={frame.color} remote={frame.remote && !groupByMachine} remoteUri={frame.remoteUri} worktree={isWt} collapsed={isCollapsed} />
              <Input autoFocus value={renaming.draft} onChange={(e) => setRenaming({ id: gid, draft: e.target.value })} onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") setRenaming(null); e.stopPropagation(); }}
                className="flex-1 min-w-0" aria-label="Rename frame" />
            </div>
          ) : (
            <button onClick={() => onFocusFrame(frame.id)} onDoubleClick={frameActions ? () => setRenaming({ id: gid, draft: frame.title }) : undefined}
              className="flex-1 flex items-center gap-2.5 min-w-0 text-left text-[14px] font-medium text-[var(--color-fg)]"
              title={isWt ? `Focus worktree ${frame.branch ?? frame.title}` : `Focus ${frame.title}${frameActions ? " · double-click to rename" : ""}`}>
              <WorkspaceIcon color={frame.color} remote={frame.remote && !groupByMachine} remoteUri={frame.remoteUri} worktree={isWt} collapsed={isCollapsed} />
              <span className="truncate">{frame.title}</span>
              {frame.folder && frame.folder !== frame.title && (
                <span className={`truncate min-w-0 font-normal ${COUNT}`} title={frame.folder}>{frame.folder}</span>
              )}
              <span className="ml-auto flex items-center gap-1.5 min-w-0">
                {/* A summary of what is hidden: when folded, or when a child needs a person. */}
                {agg && agg !== "idle" && agg !== "exited" && (isCollapsed || NEEDS_YOU(agg)) && (
                  NEEDS_YOU(agg) ? (
                    <span className="shrink-0 text-[9px] font-medium leading-none px-1.5 py-[3px] rounded-full animate-pulse"
                      style={{ color: STATUS_COLOR[agg], background: `color-mix(in srgb, ${STATUS_COLOR[agg]} 16%, transparent)` }} title={STATUS_LABEL[agg]}>
                      {STATUS_LABEL[agg]}
                    </span>
                  ) : <span aria-label={STATUS_LABEL[agg]} title={STATUS_LABEL[agg]} className="shrink-0 size-1.5 rounded-full" style={{ background: STATUS_COLOR[agg] }} />
                )}
                {items.length + kids.length > 0 && <span className={`shrink-0 ${COUNT} ${frameActions ? "group-hover/grp:hidden group-focus-within/grp:hidden" : ""}`}>{items.length + kids.length}</span>}
              </span>
            </button>
          )}
          {/* Its menu, for a pointer as for a right-click: shown on the row under the pointer. */}
          {frameActions && renaming?.id !== gid && (
            <Button variant="ghost" size="icon-2xs" aria-label={`${frame.title} actions`} title="Frame actions" data-layers-frame-menu={gid}
              className="hidden group-hover/grp:grid group-focus-within/grp:grid shrink-0"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ frame, x: r.left, y: r.bottom }); }}>
              <EllipsisVertical size={14} strokeWidth={STROKE} />
            </Button>
          )}
        </div>
        {!isCollapsed && (items.length > 0 || kids.length > 0) && (
          // Nesting guide rail the child rows hang from.
          <div className="relative">
            <span aria-hidden className="absolute top-0 bottom-1 w-px bg-[var(--color-line)]" style={{ left: depth * 14 + 18 }} />
            {items.map((t) => renderTile(t, depth + 1))}
            {kids.map((k) => renderFrameGroup(k, depth + 1, groupByMachine))}
          </div>
        )}
      </div>
    );
  };

  /** A section of its own (Pinned, a date, a status): a quiet heading that folds. */
  const section = (key: string, label: string, list: ModelTile[], attr: Record<string, string> = {}) => {
    const folded = collapsed.has(`section:${key}`);
    return (
      <section key={key} aria-label={label || "Tiles"} className="mt-2 first:mt-1" {...attr}>
        {label && (
          <button type="button" onClick={() => toggleGroup(`section:${key}`)} aria-expanded={!folded}
            className={`group/sec flex w-full items-center gap-1 h-7 pl-5 pr-3 ${LABEL} transition-colors duration-150 hover:text-[var(--color-fg)]`}>
            <span>{label}</span>
            {/* Open or folded, it says it folds: quiet until the heading is pointed at. */}
            {folded ? <ChevronRight size={11} /> : <ChevronDown size={11} className="opacity-40 transition-opacity duration-150 group-hover/sec:opacity-100" />}
            <span className={`ml-auto ${COUNT}`}>{list.length}</span>
          </button>
        )}
        {!folded && list.map((t) => renderTile(t, 0))}
      </section>
    );
  };

  const groupByMachine = prefs.groupBy === "machine" && machineGroups.length > 1;
  // Loose: in no frame, or in one that is gone. Each such frame id once, or its tiles repeat.
  const goneFrames = new Set(tiles.flatMap((t) => (t.frameId && !frames.some((f) => f.id === t.frameId) ? [t.frameId] : [])));
  const looseTiles = view.tree ? (view.byFrame.get(null) ?? []).concat([...goneFrames].flatMap((id) => view.byFrame.get(id) ?? [])) : [];
  const nothing = view.pinned.length === 0 && (view.tree ? ![...view.byFrame.values()].some((l) => l.length) : view.buckets.length === 0);
  const machineChoices = machineGroups.filter((g) => g.key === "local" || g.frames.length > 0 || g.machine);

  return (
    <aside className="hm-layers relative h-full shrink-0 flex flex-col bg-[var(--color-bg2)] border-r border-[var(--color-line)] overflow-hidden" style={{ width }} aria-label="Layers">
      {/* As a sidebar does it: whose it is and its two quick tools on top, then what you can start,
          each a row with its name, then what is open. */}
      <header className="flex items-center gap-1 pl-[14px] pr-2 h-12">
        <PanelMenu title={title} onHide={() => setHidden(true)} />
        <span className="ml-auto" />
        <Button variant="ghost" size="icon-xs" aria-label="Search tiles" title="Search tiles" aria-pressed={searching} data-layers-search-toggle
          onClick={() => { setSearching((x) => !x); setQuery(""); }}><Search size={ICON} strokeWidth={STROKE} className="size-4" /></Button>
        <Button variant="ghost" size="icon-xs" className="relative" data-layers-bell onClick={nextNeedsYou}
          aria-label={needsYou ? `${needsYou} need you: go to the next` : "Nothing needs you"} title={needsYou ? `${needsYou} need you: go to the next` : "Nothing needs you"}>
          <Bell size={ICON} strokeWidth={STROKE} className="size-4" />
          {needsYou > 0 && <span aria-hidden className="absolute -right-1 -top-1 grid min-w-3.5 h-3.5 place-items-center rounded-full px-0.5 text-[9px] font-semibold tabular-nums leading-none text-[var(--color-bg)]" style={{ background: "var(--color-warn)" }}>{needsYou}</span>}
        </Button>
      </header>
      {searching && (
        <div className="px-2 pb-1.5">
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tiles" aria-label="Search tiles" data-layers-search
            onKeyDown={(e) => { if (e.key === "Escape") { setSearching(false); setQuery(""); } e.stopPropagation(); }} className="h-7 text-[12px]" />
        </div>
      )}
      <nav aria-label="Start" className="shrink-0 pb-2">
        <NewAgentRow />
        <ActionRow icon={<FolderPlus size={ICON} strokeWidth={STROKE} />} label="New project" data="project" onClick={() => window.dispatchEvent(new CustomEvent("hivemind:add-project"))} />
        <ActionRow icon={<Server size={ICON} strokeWidth={STROKE} />} label="New machine" data="machine" onClick={() => openMachines({ kind: "add" })} />
        <ActionRow icon={<Shapes size={ICON} strokeWidth={STROKE} />} label="Add a tool or widget" data="add" onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-add"))} />
        <ActionRow icon={<Blocks size={ICON} strokeWidth={STROKE} />} label="Plugins" data="plugins" onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "plugins" } }))} />
      </nav>

      <div className="flex-1 overflow-y-auto overscroll-contain pb-2 text-[14px]">
        {tiles.length === 0 && frames.length === 0 && <div className={`pl-5 pr-3 py-2 ${LABEL} font-normal`}>No tiles open.</div>}
        {tiles.length > 0 && nothing && (
          <div className="px-4 py-3 text-[12px] text-[var(--color-fg3)]" data-layers-nothing>
            Nothing matches.{" "}
            <button type="button" className="underline hover:text-[var(--color-fg)]" onClick={() => { patchSettings("views.layers", DEFAULT_LAYERS_PREFS); setQuery(""); }}>Show everything</button>
          </div>
        )}
        {view.pinned.length > 0 && section("pinned", "Pinned", view.pinned, { "data-layers-pinned": "" })}
        {tiles.length > 0 && (
          <div className={`mt-2 flex h-7 items-center pl-5 pr-2 ${LABEL}`}>
            <span>Tiles</span>
            <span className="ml-auto"><ViewMenu prefs={prefs} setPref={setPref} machines={machineChoices} /></span>
          </div>
        )}
        {view.tree ? (
          groupByMachine
            ? machineGroups.filter((g) => (g.key === "local" && !view.filtering) || g.frames.some((f) => !view.filtering || hasShown(f.id))).map((g) => (
              <section key={g.key} aria-label={g.label} data-machine-group={g.key === "local" ? "local" : g.label} className={g.key === "local" ? "" : "mt-3 border-t border-[var(--color-line)] pt-1"}>
                <MachineHeader group={g} used needsYou={g.frames.reduce((n, f) => n + needsYouIn(f.id), 0)} />
                {g.frames.map((f) => renderFrameGroup(f, 0, true))}
              </section>
            ))
            : topFrames.map((f) => renderFrameGroup(f, 0, false))
        ) : view.buckets.map((b) => section(b.key, b.label, b.tiles, { "data-layers-bucket": b.key }))}
        {view.snoozed.length > 0 && (
          <section aria-label="Snoozed" data-layers-snoozed className="mt-2">
            <button type="button" onClick={() => toggleGroup("section:snoozed")} aria-expanded={!collapsed.has("section:snoozed")}
              className={`group/sec flex w-full items-center gap-1 h-7 pl-5 pr-3 ${LABEL} transition-colors duration-150 hover:text-[var(--color-fg)]`}>
              <span>Snoozed</span>
              {collapsed.has("section:snoozed") ? <ChevronRight size={11} /> : <ChevronDown size={11} className="opacity-40 transition-opacity duration-150 group-hover/sec:opacity-100" />}
              <span className={`ml-auto ${COUNT}`}>{view.snoozed.length}</span>
            </button>
            {!collapsed.has("section:snoozed") && view.snoozed.map((t) => (
              <TileRow key={t.id} t={t} depth={0} selected={t.id === selectedTileId} actions={rowActions} until={`until ${timeOf(t.snoozedUntil!, now)}`} />
            ))}
          </section>
        )}
        {looseTiles.length > 0 && (
          <div className="mt-1.5">
            <div className="group/loose flex items-center gap-2 h-8 pr-2 mx-2 pl-[26px]" data-layers-loose>
              <span className="flex-1 flex items-center gap-2.5 min-w-0 text-[14px] font-medium text-[var(--color-fg)]">
                <FolderOpen size={ICON} strokeWidth={STROKE} className="shrink-0 text-[var(--color-fg2)]" />
                <span className="truncate">Canvas</span>
                <span className={`ml-auto ${COUNT} group-hover/loose:hidden group-focus-within/loose:hidden`}>{looseTiles.length}</span>
                {tileActions && (
                  <button type="button" data-layers-close-loose onClick={() => setClosingLoose(true)}
                    className="ml-auto hidden group-hover/loose:block group-focus-within/loose:block focus-visible:block rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--color-fg2)] hover:bg-[var(--surface-3)] hover:text-[var(--color-fg)]">
                    Close all
                  </button>
                )}
              </span>
            </div>
            {looseTiles.map((t) => renderTile(t, 1))}
          </div>
        )}
        {recentRows.shown.length > 0 && onResume && (
          <section aria-label="Recents" data-layers-recents className="mt-3">
            <div className={`flex h-7 items-center pl-5 pr-3 ${LABEL}`}>Recents</div>
            {recentRows.shown.map((r) => (
              <button key={`${r.agent}:${r.id}`} type="button" data-layers-recent={r.id}
                onClick={() => onResume(r.agent, frames.find((f) => f.path === r.folder)?.id ?? null, r.id)}
                title={`Resume ${agentById(r.agent)?.label ?? r.agent}${r.prompt ? `: ${r.prompt}` : ""}`}
                className="flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2.5 mx-2 pl-3 pr-2 rounded-lg text-left text-[14px] text-[var(--color-fg)] transition-colors duration-150 hover:bg-[var(--surface-3)]">
                <span aria-hidden className="size-4 shrink-0 grid place-items-center text-[var(--color-fg2)]"><AgentIcon id={r.agent} size={ICON - 1} /></span>
                <span className="flex-1 truncate">{r.prompt?.split("\n")[0] || `${agentById(r.agent)?.label ?? r.agent} session`}</span>
                <span className={`shrink-0 ${COUNT}`}>{ago(r.updated ?? null, now)}</span>
              </button>
            ))}
            {recentRows.more > 0 && (
              <button type="button" onClick={() => setRecentLimit((n) => n + 10)} data-layers-recents-more
                className={`flex h-7 items-center mx-2 pl-3 pr-2 rounded-lg ${LABEL} hover:text-[var(--color-fg)]`}>
                Show {Math.min(10, recentRows.more)} more
              </button>
            )}
          </section>
        )}
        {projects.length > 1 && (
          <section aria-label="Projects" data-layers-projects className="mt-3">
            <div className={`flex h-7 items-center pl-5 pr-3 ${LABEL}`}>Projects</div>
            {projects.map((p) => {
              const here = p.repo === layoutKey;
              return (
                <button key={p.repo} type="button" disabled={here} data-layers-project={p.title}
                  onClick={() => window.dispatchEvent(new CustomEvent("hivemind:open-workspace", { detail: { repo: p.repo } }))}
                  title={here ? `${p.title} is this window` : `Open ${p.title} in this window`}
                  className="flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2.5 mx-2 pl-3 pr-2 rounded-lg text-left text-[14px] text-[var(--color-fg)] transition-colors duration-150 enabled:hover:bg-[var(--surface-3)] disabled:cursor-default">
                  <span aria-hidden className="size-4 shrink-0 grid place-items-center text-[var(--color-fg2)]">{here ? <FolderOpen size={ICON} strokeWidth={STROKE} /> : <Folder size={ICON} strokeWidth={STROKE} />}</span>
                  <span className="flex-1 truncate">{p.title}</span>
                  {p.needsYou > 0 && <span className="shrink-0 text-[10px] font-medium leading-none px-1.5 py-[3px] rounded-full" style={{ color: "var(--color-warn)", background: "color-mix(in srgb, var(--color-warn) 16%, transparent)" }}>{p.needsYou} need you</span>}
                  {p.working > 0 && <span aria-label={`${p.working} working`} className="shrink-0 size-1.5 rounded-full" style={{ background: STATUS_COLOR.working }} />}
                  <span className={`shrink-0 ${COUNT}`}>{here ? "here" : p.tiles}</span>
                </button>
              );
            })}
          </section>
        )}
      </div>
      {/* Machines nothing runs on, at the foot of the rail; the View menu can hide them. */}
      {prefs.showMachines && machineGroups.length > 1 && <IdleMachines groups={machineGroups.filter((g) => g.key !== "local" && g.frames.length === 0)} />}
      {/* Right-edge resize grip. */}
      <div onPointerDown={startResize} className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[var(--color-brand)] active:bg-[var(--color-brand)] opacity-0 hover:opacity-60" title="Drag to resize" aria-hidden />
      {menu && frameActions && (
        <FrameMenu frame={menu.frame} at={{ x: menu.x, y: menu.y }} actions={frameActions} arrange={canvas} onClose={() => setMenu(null)}
          onRename={() => setRenaming({ id: menu.frame.id, draft: menu.frame.title })} />
      )}
      {tileMenu && (
        <TileRailMenu tile={tileMenu.tile} x={tileMenu.x} y={tileMenu.y} pinned={pinnedSet.has(tileMenu.tile.id)}
          onPin={() => togglePin(tileMenu.tile.id)}
          onUnread={tileMenu.tile.activity !== null ? (on) => setSeen(tileMenu.tile.id, on ? tileMenu.tile.activity! - 1 : Date.now()) : undefined}
          onSnooze={(until) => setSnooze(tileMenu.tile.id, until)}
          onCloseTile={tileActions ? (id) => tileActions.onClose(id) : undefined}
          onRequestRename={tileActions ? (id, draft) => setRenamingTile({ id, draft }) : undefined}
          close={() => setTileMenu(null)} />
      )}
      <Dialog open={closingLoose} onOpenChange={setClosingLoose}>
        <DialogContent className="sm:max-w-[420px]" data-layers-close-loose-confirm>
          <DialogTitle>Close {looseTiles.length} {looseTiles.length === 1 ? "tile" : "tiles"} on the canvas?</DialogTitle>
          <DialogDescription>The ones in no frame. Their agents and shells end; frames and what is in them stay.</DialogDescription>
          <DialogFooter>
            <Button variant="ghost" autoFocus onClick={() => setClosingLoose(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => { setClosingLoose(false); for (const t of looseTiles) tileActions?.onClose(t.id); }}>Close {looseTiles.length}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {card && <HoverCard tile={card.tile} top={card.top} left={card.left} now={now} frame={frames.find((f) => f.id === card.tile.frameId)} agent={agentLabel(card.tile)} />}
    </aside>
  );
});

/** One thing to start, named: the same row as a tile's, so the panel reads as one list. */
/** A row that starts something. The first one leads; the rest are quieter until pointed at. A key
 *  shows as a keycap on the row under the pointer or focus. */
function ActionRow({ icon, label, hint, data, primary, onClick }: { icon: ReactNode; label: string; hint?: string; data: string; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} data-layers-action={data}
      className={`group/act flex w-[calc(100%-1rem)] min-w-0 h-8 items-center gap-2.5 mx-2 pl-3 pr-1.5 rounded-lg text-left text-[13.5px] transition-colors duration-150 hover:bg-[var(--surface-3)] hover:text-[var(--color-fg)] outline-none focus-visible:bg-[var(--surface-3)] focus-visible:text-[var(--color-fg)] ${primary ? "font-medium text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}>
      <span aria-hidden className={`size-4 shrink-0 grid place-items-center ${primary ? "text-[var(--color-fg)]" : ""}`}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {hint && (
        <kbd aria-hidden className="grid min-w-[18px] h-[18px] place-items-center rounded-[5px] px-1 font-sans text-[11px] leading-none tabular-nums text-[var(--color-fg2)] shadow-[inset_0_0_0_1px_var(--color-line2)] opacity-0 transition-opacity duration-150 group-hover/act:opacity-100 group-focus-visible/act:opacity-100">
          {hint}
        </kbd>
      )}
    </button>
  );
}

/** New agent: which one, from the agents installed here; the default (key 2) first. With none
 *  installed it opens Settings ▸ Agents, where one is got. */
function NewAgentRow() {
  const [open, setOpen] = useState(false);
  const presence = useAgentPresence();
  const chosen = useSettings().agents.defaultAgent;
  const ready = useAgents().filter((a) => a.enabled && !notReady(presence, a.id));
  const first = preferredAgent(chosen, (d) => !notReady(presence, d.id))?.id;
  const ordered = [...ready].sort((a, b) => Number(b.id === first) - Number(a.id === first));
  const getOne = () => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "agents" } }));
  // Where the 2 key puts one: the selected frame, else the one asked for.
  const start = (agent: string) => window.dispatchEvent(new CustomEvent("hivemind:spawn-agent", { detail: { agent } }));
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <div className="relative">
        <ActionRow primary icon={<SquarePen size={ICON} strokeWidth={STROKE} />} label="New agent" hint="2" data="agent"
          onClick={() => (ordered.length ? setOpen(true) : getOne())} />
        <DropdownMenuTrigger asChild><span aria-hidden className="absolute bottom-0 left-4 size-0" /></DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="start" sideOffset={2} className="w-[220px]" data-layers-new-agent>
        {ordered.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => start(a.id)} data-layers-new-agent-choice={a.id}>
            <AgentIcon id={a.id} size={ICON} />{a.label}
            {a.id === first && <DropdownMenuShortcut>2</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={getOne}><Blocks />Get more agents…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The panel's title: the workspace, and what concerns the panel itself. */
function PanelMenu({ title, onHide }: { title: string; onHide: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <span className="relative inline-flex min-w-0">
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} data-layers-title
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[15px] font-semibold tracking-[-0.014em] text-[var(--color-fg)] transition-colors duration-150 hover:bg-[var(--surface-3)]">
          <span className="truncate">{title}</span>
          <ChevronDown size={14} className="shrink-0 text-[var(--color-fg3)]" />
        </button>
        <DropdownMenuTrigger asChild><span aria-hidden className="absolute bottom-0 left-0 size-0" /></DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="start" className="w-[210px]">
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("hivemind:open-recent"))}><History />Recent projects…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => window.dispatchEvent(new CustomEvent("hivemind:add-project"))}><FolderPlus />Open a project…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onHide} data-layers-hide><PanelLeftClose />Hide panel<DropdownMenuShortcut>⌘B</DropdownMenuShortcut></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The panel's View menu: which tiles (status, last activity, machines), grouped and ordered how. */
function ViewMenu({ prefs, setPref, machines }: { prefs: LayersPrefs; setPref: (k: keyof LayersPrefs, v: unknown) => void; machines: MachineGroup[] }) {
  const radio = <K extends "status" | "activity" | "groupBy" | "sortBy">(key: K, label: string) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-layers-view={key}>
        <span className="flex-1">{label}</span>
        <span className="text-[11.5px] text-[var(--color-fg3)]">{choiceLabel(key, prefs[key])}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-[170px]">
        <DropdownMenuRadioGroup value={prefs[key]} onValueChange={(v) => setPref(key, v)}>
          {VIEW_CHOICES[key].map(([id, text]) => <DropdownMenuRadioItem key={id} value={id} data-layers-choice={`${key}:${id}`}>{text}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  const chosen = prefs.machines;
  const toggleMachine = (key: string) => setPref("machines", chosen.includes(key) ? chosen.filter((m) => m !== key) : [...chosen, key]);
  const altered = JSON.stringify(prefs) !== JSON.stringify(DEFAULT_LAYERS_PREFS);
  const filtered = prefs.status !== "all" || prefs.activity !== "all" || prefs.machines.length > 0;
  const [open, setOpen] = useState(false);
  // Opened by the button, anchored under it: the app's menus open from code, as the row menus do.
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <span className="relative inline-flex">
        <Button variant="ghost" size="2xs" aria-label="View options" title="What is listed, grouped and ordered how" data-layers-view-menu aria-expanded={open} className="relative text-[11px] font-medium" onClick={() => setOpen(true)}>
          {prefs.groupBy === "none" ? "Not grouped" : `By ${choiceLabel("groupBy", prefs.groupBy).toLowerCase()}`}
          {filtered && <span className="text-[var(--color-brand)]">· filtered</span>}
          <ChevronDown size={11} />
        </Button>
        <DropdownMenuTrigger asChild><span aria-hidden className="absolute bottom-0 right-0 size-0" /></DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="end" className="w-[220px]">
        {radio("status", "Status")}
        {radio("activity", "Last activity")}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-layers-view="machines">
            <span className="flex-1">Machines</span>
            <span className="text-[11.5px] text-[var(--color-fg3)]">{chosen.length === 0 ? "All" : `${chosen.length} selected`}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[200px]">
            <DropdownMenuCheckboxItem checked={chosen.length === 0} onCheckedChange={() => setPref("machines", [])} onSelect={(e) => e.preventDefault()} data-layers-machine="all">All machines</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            {machines.map((g) => (
              <DropdownMenuCheckboxItem key={g.key} checked={chosen.includes(g.key)} onCheckedChange={() => toggleMachine(g.key)} onSelect={(e) => e.preventDefault()} data-layers-machine={g.key}>
                <span className="truncate">{g.label}</span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {radio("groupBy", "Group by")}
        {radio("sortBy", "Sort by")}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={prefs.showMachines} onCheckedChange={(v) => setPref("showMachines", !!v)} onSelect={(e) => e.preventDefault()} data-layers-show-machines>
          Show idle machines
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled={!altered} onSelect={() => patchSettings("views.layers", DEFAULT_LAYERS_PREFS)} data-layers-reset>Reset to defaults</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What a row is, on hover: its name, when it last changed, and where it runs. */
function HoverCard({ tile, top, left, now, frame, agent }: { tile: ModelTile; top: number; left: number; now: number; frame?: LayerFrame; agent: string }) {
  const when = ago(tile.activity, now);
  return (
    // `.hm-popover` brings its own 4px padding; the card's spacing is on the inner box.
    <div role="tooltip" data-layers-card className="hm-popover pointer-events-none fixed z-50 w-[256px] animate-in fade-in-0 slide-in-from-left-1 duration-150 ease-out" style={{ top, left }}>
      <div className="px-3 pt-2.5 pb-3">
        <p className="truncate text-[14px] font-semibold leading-5 text-[var(--color-fg)]">{tile.name}</p>
        <p className="mt-1 text-[12px] leading-4 text-[var(--color-fg2)]">{[when, tile.needsYou ? "needs you" : STATUS_LABEL[tile.status]].filter(Boolean).join(" · ")}</p>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] leading-4 text-[var(--color-fg2)]">
          <span className="rounded-md bg-[var(--color-bg3)] px-2 py-0.5">{agent}</span>
          {frame && <span className="max-w-full truncate rounded-md bg-[var(--color-bg3)] px-2 py-0.5">{frame.title}</span>}
          {frame?.branch && <span className="max-w-full truncate rounded-md bg-[var(--color-bg3)] px-2 py-0.5 font-mono">{frame.branch}</span>}
        </div>
      </div>
    </div>
  );
}

interface MachineGroup { key: string; label: string; hostId?: string; machine?: MachineInfo; frames: LayerFrame[] }

/** A tile row's menu (its ⋮, or a right-click): pin, rename, close, each with its key while open. */
function TileRailMenu({ tile, x, y, pinned, onPin, onUnread, onSnooze, onCloseTile, onRequestRename, close }: {
  tile: ModelTile;
  x: number;
  y: number;
  pinned: boolean;
  onPin: () => void;
  /** Mark it unread (true) or read; absent when nothing it did is known yet. */
  onUnread?: (unread: boolean) => void;
  /** Snooze it until then, or wake it (null). */
  onSnooze: (until: number | null) => void;
  onCloseTile?: (id: string) => void;
  onRequestRename?: (id: string, draft: string) => void;
  close: () => void;
}) {
  const run = (fn?: () => void) => { close(); fn?.(); };
  const unread = isUnread(tile);
  const keys: Record<string, (() => void) | undefined> = {
    p: onPin,
    u: onUnread && (() => onUnread(!unread)),
    r: onRequestRename && (() => onRequestRename(tile.id, tile.name)),
    d: onCloseTile && (() => onCloseTile(tile.id)),
  };
  return (
    <DropdownMenu open onOpenChange={(o) => { if (!o) close(); }}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: "fixed", left: x, top: y, width: 0, height: 0 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={2} className="w-[190px]" data-layers-tile-actions
        onKeyDown={(e) => { const fn = keys[e.key.toLowerCase()]; if (fn && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); run(fn); } }}>
        <DropdownMenuLabel className="px-2 pt-1 pb-1 text-[9px] uppercase tracking-[0.12em] text-[var(--color-fg3)] font-semibold truncate">{tile.name}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => run(onPin)} data-layers-pin>
          <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]">{pinned ? <PinOff size={13} /> : <Pin size={13} />}</span>
          <span className="truncate">{pinned ? "Unpin" : "Pin"}</span>
          <DropdownMenuShortcut>P</DropdownMenuShortcut>
        </DropdownMenuItem>
        {onUnread && (
          <DropdownMenuItem onSelect={() => run(keys.u)} data-layers-unread>
            <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]">{unread ? <MailOpen size={13} /> : <Mail size={13} />}</span>
            <span className="truncate">{unread ? "Mark as read" : "Mark as unread"}</span>
            <DropdownMenuShortcut>U</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {tile.snoozedUntil ? (
          <DropdownMenuItem onSelect={() => run(() => onSnooze(null))} data-layers-wake>
            <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]"><AlarmClockOff size={13} /></span>
            <span className="truncate">Wake now</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-layers-snooze>
              <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]"><AlarmClock size={13} /></span>
              <span className="truncate flex-1">Snooze</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[180px]">
              {SNOOZES.map(([label, until]) => (
                <DropdownMenuItem key={label} onSelect={() => run(() => onSnooze(until(Date.now())))} data-layers-snooze-choice={label}>{label}</DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {onRequestRename && (
          <DropdownMenuItem onSelect={() => run(keys.r)}>
            <span className="shrink-0 grid place-items-center size-4 text-[var(--color-fg3)]"><Pencil size={13} /></span>
            <span className="truncate">Rename</span>
            <DropdownMenuShortcut>R</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {onCloseTile && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => run(keys.d)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
              <span className="shrink-0 grid place-items-center size-4"><Trash size={13} /></span>
              <span className="truncate">Close tile</span>
              <DropdownMenuShortcut>D</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const RETRYABLE = new Set(["offline", "reconnecting", "no-hive", "idle"]);
const DOWN = new Set(["offline", "reconnecting", "attention"]);

/** Machines nothing on this canvas runs on: one quiet, foldable list instead of a heading each. */
function IdleMachines({ groups }: { groups: MachineGroup[] }) {
  const snap = useMachines();
  const [open, setOpen] = useState<boolean>(() => {
    const v = localStorage.getItem("hivemind:layers-idle-machines");
    return v === null ? groups.length <= 3 : v === "1";
  });
  if (groups.length === 0) return null;
  const toggle = () => setOpen((o) => { localStorage.setItem("hivemind:layers-idle-machines", o ? "0" : "1"); return !o; });
  const signIn = groups.filter((g) => statusOf(snap, g.hostId ?? null).state === "attention").length;
  const down = groups.filter((g) => g.machine?.enabled !== false && DOWN.has(statusOf(snap, g.hostId ?? null).state)).length - signIn;
  const summary = [signIn && `${signIn} to sign in`, down > 0 && `${down} offline`].filter(Boolean).join(" · ");
  return (
    <section aria-label="other machines" data-idle-machines className="shrink-0 max-h-[40%] overflow-y-auto overscroll-contain border-t border-[var(--color-line)] pt-1 pb-1 bg-[var(--color-bg2)]">
      <button
        onClick={toggle}
        aria-expanded={open}
        className={`sticky top-0 z-10 bg-[var(--color-bg2)] w-full flex items-center gap-1 h-7 pl-5 pr-3 ${LABEL} hover:text-[var(--color-fg)] cursor-pointer`}
      >
        <span>Machines</span>
        <span className={COUNT}>{groups.length}</span>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {!open && summary && <span className="ml-auto font-normal truncate">{summary}</span>}
      </button>
      {open && groups.map((g) => (
        <section key={g.key} aria-label={g.label} data-machine-group={g.label}>
          <MachineHeader group={g} used={false} needsYou={0} />
        </section>
      ))}
    </section>
  );
}

/** A computer's row in Layers: its link, what needs you there, and what you can do with it. */
function MachineHeader({ group, needsYou, used }: { group: MachineGroup; needsYou: number; used: boolean }) {
  const snap = useMachines();
  const [menu, setMenu] = useState(false);
  const m = group.machine;
  const s = statusOf(snap, group.hostId ?? null);
  const on = m?.enabled ?? true;
  const act = (fn: () => unknown) => () => { setMenu(false); void fn(); };
  const retry = () => (s.state === "attention" || !m ? openMachines({ kind: "manage" }) : window.hive.machineCheck(m.id).catch(() => {}));
  return (
    <div
      className={`group/mach relative flex items-center gap-1.5 h-7 pr-2 ${used
        ? `pl-5 mt-2 ${LABEL}`
        : "pl-7 mx-2 rounded-lg text-[13px] text-[var(--color-fg2)] hover:bg-[var(--color-bg3)]"}`}
      data-machine-header={group.key === "local" ? "local" : group.label}
      title={m ? `${m.target}${s.detail ? ` — ${s.detail}` : ""}` : undefined}
    >
      {group.hostId && <MachineDot status={s} enabled={on} size={6} />}
      <span className={`truncate min-w-0 ${on ? "" : "opacity-60"} ${used ? "" : "text-[var(--color-fg2)]"}`}>{group.label}</span>
      {group.hostId && (
        <span className="shrink-0 font-mono normal-case tracking-normal font-normal text-[10.5px] tabular-nums" data-machine-state>
          {statusWords(s, on)}
        </span>
      )}
      {needsYou > 0 && (
        <span className="shrink-0 flex items-center gap-0.5 font-mono tracking-normal text-[var(--color-warn)]" title={`${needsYou} need you on ${group.label}`} data-machine-needs-you>
          <span aria-hidden className="size-1.5 rounded-full animate-pulse" style={{ background: "var(--color-warn)" }} />
          {needsYou}
        </span>
      )}
      {m && (
        <span className="ml-auto flex items-center gap-0.5 normal-case tracking-normal">
          {/* Only a machine in use that is down keeps a button showing; the rest wait for hover or focus. */}
          <span className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 rounded-md bg-[var(--color-bg2)] shadow-[-8px_0_8px_var(--color-bg2)] ${menu ? "" : "opacity-0 group-hover/mach:opacity-100 focus-within:opacity-100"}`}>
          {(on && RETRYABLE.has(s.state)) || s.state === "attention" ? (
            <Button variant="ghost" size="icon-2xs" onClick={retry} title={s.state === "attention" ? "Sign in…" : "Retry now"} aria-label={`retry ${m.label}`}>
              <RefreshCw size={12} />
            </Button>
          ) : null}
          {on && (
            <Button variant="ghost" size="icon-2xs" onClick={() => openMachines({ kind: "pick", frameId: null, machineId: m.id })} title={`Open a folder on ${m.label}`} aria-label={`open folder on ${m.label}`}>
              <Plus size={12} />
            </Button>
          )}
          <Button variant="ghost" size="icon-2xs" onClick={() => setMenu((x) => !x)} aria-label={`${m.label} actions`}>
            <Ellipsis size={12} />
          </Button>
          </span>
          {used && on && DOWN.has(s.state) && !menu && (
            <Button variant="ghost" size="icon-2xs" onClick={retry} className="group-hover/mach:hidden" title={s.state === "attention" ? "Sign in…" : "Retry now"} aria-hidden tabIndex={-1}>
              <RefreshCw size={12} />
            </Button>
          )}
        </span>
      )}
      {menu && m && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="hm-popover absolute right-2 top-7 z-20 w-[180px] flex flex-col text-[12px] normal-case tracking-normal font-normal">
            {on && <MenuItem onClick={act(() => openMachines({ kind: "pick", frameId: null, machineId: m.id }))}>Open folder here…</MenuItem>}
            {on && <MenuItem onClick={act(retry)}>Check now</MenuItem>}
            <MenuItem onClick={act(() => window.hive.machineUpdate(m.id, { enabled: !on }))}>{on ? "Turn off" : "Turn on"}</MenuItem>
            <MenuItem onClick={act(() => openMachines({ kind: "manage" }))}>Manage machines…</MenuItem>
          </div>
        </>
      )}
    </div>
  );
}
