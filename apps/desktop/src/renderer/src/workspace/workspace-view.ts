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
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { FrameState, TileInstance } from "../canvas-persistence";
import type { LayerFrame, LayerTile } from "../LayersPanel";
import type { FrameActions } from "../FrameRailMenu";
import type { TileKind } from "../tile-kinds";

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
 *    `agent-status-bus` per tile (~1 Hz, selective); `model.agentTitles` churns
 *    ~600 ms while an agent streams — never key a heavy memo or a whole-scene
 *    rebuild on it.
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
}

// ── registry ─────────────────────────────────────────────────────────────────
// Built-in views register at startup (workspace/views/index.ts). Third-party
// views are NOT loaded here: anything registered runs in the privileged
// renderer with full `window.hive` access, so registration is a build-time
// decision. Isolated community plugins are a later phase (see the design doc).

const views = new Map<string, WorkspaceViewPlugin>();

/** The view we fall back to when the stored/requested one is unknown or crashes. */
export const FALLBACK_VIEW_ID = "canvas";

export function registerView(plugin: WorkspaceViewPlugin): void {
  views.set(plugin.id, plugin);
}

export function getView(id: string): WorkspaceViewPlugin | undefined {
  return views.get(id);
}

/** Registration order — also the ⌘E cycle order and the Settings list order. */
export function listViews(): WorkspaceViewPlugin[] {
  return [...views.values()];
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
}
