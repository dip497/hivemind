/**
 * workspace-view — the contract between the workspace RUNTIME (Workspace.tsx:
 * frames, repo bindings, tile identity, sessions, commands, events, persistence)
 * and a VIEW plugin (how those tiles are arranged and navigated: an infinite
 * canvas, a tab strip, later a Three.js world).
 *
 * A view receives a read-only MODEL + a COMMANDS bag and renders `<TileSlot>`s
 * (tile-host.tsx) wherever a tile body belongs. It never receives react-flow
 * nodes, never renders a tile body itself, and never owns a session: the runtime
 * keeps every surface alive across view switches (see tile-host.tsx). What a
 * view DOES own is its arrangement/navigation state, persisted separately and
 * versioned per view via `useViewLayout` (view-layout-store.ts).
 *
 * Full contract + follow-up phases (Three.js demo, isolated community plugins):
 * docs/design/workspace-views.md.
 */
import { useSyncExternalStore, type ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { IslandPlacement } from "@hivemind/core/settings-schema";
import type { FrameState, TileInstance } from "../canvas-persistence";
import type { LayerFrame, LayerTile } from "../LayersPanel";
import type { FrameActions } from "../FrameRailMenu";
import type { TileKind } from "../tile-kinds";
import type { StatusEvent, TileStatusKind } from "../agent-status-bus";

/** Read-only snapshot of the workspace a view renders from. */
export interface WorkspaceViewModel {
  repoPath: string | null;
  root: string | null;
  cwd: string;
  /** Per-repo persistence key (null = transient welcome/e2e session). Views key
   *  their own layout blobs on it via `useViewLayout`. */
  layoutKey: string | null;
  tiles: TileInstance[];
  frames: FrameState[];
  /** Explicit tile → frame membership (authoritative; geometry never decides). */
  frameOf: Record<string, string>;
  /** User renames (absent = auto/agent name). */
  tileNames: Record<string, string>;
  /** Live agent OSC titles (churn ~600ms while streaming — don't key heavy
   *  memos on it). */
  agentTitles: Record<string, string>;
  selectedTileId: string | null;
  selectedFrameId: string | null;
  /** Flattened, display-ready listing (name resolution + repo gating applied) —
   *  what the Layers rail, a tab strip, or a 3D label set would show. */
  layerTiles: LayerTile[];
  layerFrames: LayerFrame[];
  /** Frame-level actions (spawn into / worktree / workspace / git …). */
  frameActions: FrameActions;
  /** Live agent wiring — data-flow pipes (hive_connect) + spawn parentage. */
  links: { pipes: { src: string; dst: string }[]; spawnLinks: { parent: string; child: string }[] };
}

export type SpawnOpts = {
  mode?: string;
  work?: string;
  url?: string;
  /** Editor tiles: the file the fresh (or reused) editor should open. */
  file?: string;
  agent?: { id: string; cmd: string; args?: string[]; label: string };
};

/** What a view may ask the runtime to do. Everything here is view-agnostic. */
export interface WorkspaceCommands {
  selectTile: (id: string | null) => void;
  selectFrame: (id: string | null) => void;
  /** Bring a tile/frame into view. The canvas flies its camera; other views
   *  treat it as select + reveal. `exact` asks for 1:1 (terminal/editor text). */
  focusTile: (id: string, opts?: { exact?: boolean }) => void;
  closeTile: (id: string) => void;
  spawnTile: (kind: TileKind, frameId: string | null, opts?: SpawnOpts) => void;
  spawnVis: (which: "tree" | "shell" | "diff" | "issues") => void;
  spawnClaude: () => void;
  addFrame: () => void;
  /** Live agent status, PER TILE, off the awareness bus. Deliberately not on
   *  the model: a status transition (~1 Hz while agents work) reaches only the
   *  subscribers of that tile — a 3D view colours one object, a rail recolours
   *  one row — and never re-renders every body the way a model change would.
   *  Replays the last known status synchronously on subscribe. Returns the
   *  unsubscribe; a view MUST call it when the object/row goes away. */
  subscribeTileStatus: (tileId: string, cb: (status: TileStatusKind, event: StatusEvent) => void) => () => void;
  /** Last known effective status of a tile (null before it has reported). */
  tileStatus: (tileId: string) => TileStatusKind | null;
}

export interface WorkspaceViewProps {
  model: WorkspaceViewModel;
  commands: WorkspaceCommands;
}

/**
 * A view plugin. PERFORMANCE CONTRACT (zero perceptible lag is an acceptance
 * criterion, not polish — see docs/design/workspace-views.md "Performance"):
 *
 *  • Never render a tile body yourself; one `<TileSlot>` per visible tile. A
 *    second instance of a live terminal is a correctness AND a perf bug.
 *  • Do not subscribe to terminal output or per-chunk events. Status comes from
 *    `commands.subscribeTileStatus` per tile (~1 Hz, selective — a change
 *    touches one subscriber, not the model); `model.agentTitles` churns ~600 ms
 *    while an agent streams — never key a heavy memo or a whole-scene rebuild
 *    on it.
 *  • Own your listeners/timers/rAF loops and tear them ALL down on unmount; the
 *    runtime unmounts the previous view on every switch and remounts it later.
 *    A view that is not active must do zero work (no background render loop).
 *  • Pause presentation while hidden (`document.hidden`, window blur) — the
 *    sessions keep running in the TileHost regardless.
 *  • Heavy renderers (Three.js) ship as a `React.lazy` component so the default
 *    path pays nothing; a switch waits on the chunk once.
 *  • Persist arrangement through `useViewLayout` (debounced, versioned) — no
 *    synchronous serialization on the interaction path.
 */
export interface WorkspaceViewPlugin {
  /** Stable id — persisted as the user's view preference + the layout-blob key. */
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** May be `React.lazy(...)` — the ViewHost wraps it in Suspense. */
  component: ComponentType<WorkspaceViewProps>;
  /** Built-ins run in the renderer; community views run in a sandboxed iframe
   *  (workspace/views/community). Default "builtin". */
  source?: "builtin" | "community";
  /** Host chrome the runtime draws OVER this view (workspace/host-chrome.tsx).
   *  Partial: see `resolveChrome` for the defaults. */
  chrome?: Partial<ViewChrome>;
}

/** What the workspace runtime renders around a view, whatever the view is. */
export interface ViewChrome {
  /** Where the tool island (spawn / frame / browser / appearance) sits.
   *  "hidden" leaves a collapsed handle; "off" mounts neither toolbar nor
   *  handle. App-level Settings remains available independently. */
  island: IslandPlacement;
  /** Mount the animated wallpaper layer (and frost tile content) under this
   *  view. A view that paints an opaque scene of its own turns it off: the
   *  wallpaper would be invisible under it and its animation and glass blur
   *  would still cost every frame. */
  wallpaper: boolean;
}

/** A view's chrome with the defaults filled in: a compact bottom island, and the
 *  user's wallpaper behind it. A view that paints its own opaque scene opts out
 *  (`"wallpaper": false` in its manifest); the built-ins declare theirs. */
export function resolveChrome(plugin: Pick<WorkspaceViewPlugin, "chrome"> | null | undefined): ViewChrome {
  return { island: plugin?.chrome?.island ?? "bottom", wallpaper: plugin?.chrome?.wallpaper ?? true };
}

// ── registry ─────────────────────────────────────────────────────────────────
// Built-in views register at startup (workspace/views/index.ts) and run in the
// privileged renderer. Community views register at runtime through
// workspace/views/community (their code runs in a sandboxed iframe; the
// registered component is the host that embeds it). The registry is an
// external store: `useViews()` re-renders switchers when the set changes
// (a repo switch, a `hive views install`, a plugin disabled for misbehaving).

const views = new Map<string, WorkspaceViewPlugin>();
const listeners = new Set<() => void>();
let snapshot: WorkspaceViewPlugin[] = [];
function changed() { snapshot = [...views.values()]; for (const l of listeners) l(); }

/** The view we fall back to when the stored/requested one is unknown or crashes. */
export const FALLBACK_VIEW_ID = "canvas";

export function registerView(plugin: WorkspaceViewPlugin): void {
  views.set(plugin.id, plugin);
  changed();
}

export function unregisterView(id: string): void {
  if (views.delete(id)) changed();
}

export function subscribeViews(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The registered views as a stable array (registration order); re-renders on change. */
export function useViews(): WorkspaceViewPlugin[] {
  return useSyncExternalStore(subscribeViews, () => snapshot, () => snapshot);
}

export function getView(id: string): WorkspaceViewPlugin | undefined {
  return views.get(id);
}

/** Registration order — also the ⌘E cycle order and the Settings list order. */
export function listViews(): WorkspaceViewPlugin[] {
  return snapshot;
}

/** Map a stored/requested id to one that is actually registered: the id itself,
 *  else the fallback, else whatever registered first. Null when nothing is
 *  registered (the runtime then renders its failure panel). */
export function resolveViewId(raw: string | null | undefined): string | null {
  if (raw && views.has(raw)) return raw;
  if (views.has(FALLBACK_VIEW_ID)) return FALLBACK_VIEW_ID;
  return listViews()[0]?.id ?? null;
}

/** The view after `current` in registration order (wraps). ⌘E. */
export function nextViewId(current: string | null): string | null {
  const ids = listViews().map((v) => v.id);
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  return ids[(i + 1) % ids.length] ?? null;
}

/** Test seam — forget every registration. */
export function _resetViewsForTest(): void {
  views.clear();
  changed();
}
