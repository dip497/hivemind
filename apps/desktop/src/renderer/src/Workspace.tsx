/**
 * Workspace — the workspace RUNTIME and composition root (formerly Canvas.tsx).
 *
 * Owns what every view shares: frames + their repo bindings (worktree /
 * workspace / remote), tile identity + open set + membership, selection, names,
 * editor tabs, the HCP control-plane wiring, agent awareness, commands (spawn /
 * close / focus / …) and persistence of the core blob. It renders:
 *
 *   • the ACTIVE VIEW plugin (workspace/views — canvas, windows, …) behind a
 *     crash boundary with fallback (workspace/view-host.tsx); a view receives a
 *     read-only model + commands, never react-flow nodes;
 *   • the TileHost (workspace/tile-host.tsx) — every open tile's live body,
 *     mounted ONCE for the life of the tile and lent to whichever view shows it,
 *     so switching views never remounts a terminal / editor / browser (a remote
 *     PTY has no daemon; its unmount would kill the agent);
 *   • the cross-view overlays (spawn/claude pickers, remote-connect and git
 *     modals).
 *
 * Milestone-1 seam: the canvas view's geometry (tile positions/sizes/viewport)
 * still lives here and reaches CanvasView through CanvasRuntimeContext, because
 * the hooks that mutate it (useSpawn placement, useFrameOps auto-fit,
 * useWorktrees, useNodeDragStop) also do core work and must run while another
 * view is active. See workspace/views/canvas-runtime.ts + the design doc.
 *
 * The work lives in extracted modules/hooks that destructure a `ctx` object —
 * keep it that way (this file was decomposed out of a 3147-LOC god component).
 */
import { lookAt } from "./workspace/tile-look";
import { clearWork } from "./work-queue";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "./components/ui/button";
import { DeleteFrameDialog, type FrameDeleteAsk } from "./DeleteFrameDialog";
import { useSleepAgents } from "./workspace/SleepAgents";
import { Plus } from "./components/icons";
import { PickerDialog } from "./picker-dialog";
import { isPluginVerb, pluginVerb, type PluginVerbHost } from "./workspace/plugin-verbs";
import type { LayerTile, LayerFrame } from "./LayersPanel";
import { forgetStatus, statusOf, setHostedStatus, type TileStatusKind, subscribeTileStatus } from "./agent-status-bus";
import { ToolPlugins, WorkspacePropsContext } from "./tiles/tool-plugins";
import { tileName } from "@hivemind/workspace-doc/tile-list";
import { cleanName } from "@hivemind/agents";
import { frameAtPoint } from "./frame-layout";
import { Wallpaper } from "./Wallpaper";
import { CanvasOverlay } from "./CanvasOverlay";
import { applyTheme, setPluginScene, setWallpaperActive } from "./theme-store";
import { patchSettings, useSettings } from "./settings-store";
import type { PinRect } from "./workspace/tile-surfaces";
import { clampAnchor } from "./pin-anchor";
import { pickEditorTile } from "./workspace/editor-target";
import type { TileKind } from "./tile-kinds";
import { tileKind, useTilesVersion } from "./tiles";
import { kindsThatOpenNow } from "./tool-availability";
import {
  loadLayout,
  reloadLayout,
  saveLayout,
  type TileInstance,
  type FrameState,
} from "./canvas-persistence";
import { useStateWithRef } from "./use-state-with-ref";
import { useBoard } from "./board-objects/useBoard";
import type { BoardChoice, Point } from "./board-objects/board-model";
import { useEnabledWidgetPackages, useShownWorkspace, useWidgetRuntime } from "./board-objects/widget-runtime";
import { BoardContext } from "./board-objects/board-context";
import { markRestored, whenBootIdle } from "./boot-queue";
/** How long the catalog check waits for restored tiles to start before going anyway: an agent
 *  this version cannot load is a tile that may never start, and the check is its repair. */
const BOOT_WAIT_CAP_MS = 60_000;
/** A check that changed nothing while an agent is still broken is worth asking again — the
 *  registry is on the other side of someone's network. */
const CATALOG_RETRY_MS = 45_000;
const CATALOG_RETRIES = 3;
import { defaultSizeForKind, defaultTileSize, snapToGrid } from "./canvas-sizing";
import { useWorktrees } from "./useWorktrees";
// Loaded when it is first opened: the dialog (add form, machine list, folder picker) is not startup work.
// Only a workspace with floating widgets, or a plugin asking to tell an agent something, needs these.
const WidgetLayer = lazy(() => import("./board-objects/WidgetLayer").then((m) => ({ default: m.WidgetLayer })));
const WidgetLinks = lazy(() => import("./board-objects/WidgetLinks").then((m) => ({ default: m.WidgetLinks })));
const MachinesHub = lazy(() => import("./machines/MachinesHub").then((m) => ({ default: m.MachinesHub })));
import { frameMachine, placeOf, useMachines, type MachinesRequest } from "./machines/store";
import { useMachineOwners } from "./machines/owners";
import { rebindFrames } from "./machines/frame-binding";
import type { MachineInfo, SessionSummary } from "../../shared/ipc";
import type { AgentItem } from "@hivemind/workspace-api/agents";
import { isRemote } from "@hivemind/core/remote-uri";
import { AgentIcon, agentById, agentForCmd, useAgents } from "./agents";
import { useSpawn } from "./useSpawn";
import { useFrameOps } from "./useFrameOps";
import { useAgentAwareness } from "./useAgentAwareness";
import { markBackgroundTile, unmarkBackgroundTile } from "./worker-tiles";
import type { TileOpened } from "@hivemind/workspace-api/agents";
import { useCanvasShortcuts } from "./useCanvasShortcuts";
import { useNodeDragStop } from "./useNodeDragStop";
import { GitCommitModal } from "./GitCommitModal";
import { useGitPush, useGitPull } from "./queries";
import { createTileSurfaceBuilder } from "./workspace/tile-surfaces";
import { TileHost } from "./workspace/tile-host";
import { ViewHost } from "./workspace/view-host";
import { SayHere } from "./multiplayer/presence";
import { joinedId } from "./multiplayer/shown";
import { openAdd } from "./workspace/add-dialog";
import { HostChrome } from "./workspace/host-chrome";
import { openAppearanceSettings } from "./workspace/chrome-store";
import { openViewMenu } from "./workspace/standard-toolbar";
import { loadCommunityViews } from "./workspace/views/community/registry";
import { agentScanProblems, syncAgentPlugins } from "./agent-plugins";
import {
  FALLBACK_VIEW_ID, getView, resolveChrome, resolveViewId, useViews,
  type SpawnOpts, type WorkspaceCommands, type WorkspaceViewModel,
} from "./workspace/workspace-view";
import { saveViewLayout, useDebouncedSave, useViewLayout } from "./workspace/view-layout-store";
import { onStoreChange, showWorkspace } from "./workspace/workspace-store-client";
import { setViewMode, useViewMode } from "./workspace/view-mode-store";
import { useSharedDefaultView } from "./workspace/shared-default-view";
import { CANVAS_CAMERA, CANVAS_LAYOUT, loadCanvasCamera, loadCanvasLayout, reloadCanvasLayout } from "./workspace/views/canvas-layout";
import { PIN_SIZE, PINS } from "./workspace/pins";
import { CanvasRuntimeContext, type CanvasRuntime, type FocusModeReq, type FocusReq, type Viewport } from "./workspace/views/canvas-runtime";
// Registers the built-in view plugins (side effect) before the first render.
import "./workspace/views";
import { agentById as catalogAgentById } from "@hivemind/agents";
import { agentToStart, noAgentInstalled } from "./agent-plugins";
import { useReadyAgents } from "./agent-choice";
import { AGENT_TILE_KIND, isTerminalKind } from "./tile-kinds";
import { endTileSession } from "./TerminalTile";

const DEFAULT_VIEWPORT: Viewport = { x: 16, y: 24, zoom: 1 };
/** A Send to agent row that starts a new tile of the agent named after it. */
const NEW_AGENT_ROW = "new:";
/** The agent that runs in a tile, when one does. */
const agentOfTile = (t: TileInstance): string | undefined => (t.kind === AGENT_TILE_KIND ? agentForCmd(t.cmd)?.id : undefined);
/** A per-tile map without `id`'s entry: the map itself when it has none, so dropping nothing re-renders nothing. */
const withoutKey = <T,>(id: string) => (m: Record<string, T>): Record<string, T> => {
  if (!(id in m)) return m;
  const { [id]: _drop, ...rest } = m;
  return rest;
};

interface Props {
  cwd: string;
  repoPath: string | null;
  /** Workspace root (.hivemind parent) — issues are keyed by this, not repoPath. */
  root?: string | null;
  /** A newer GitHub release exists → show the "Update available" pill by Theme.
   *  Owned by App (so the Settings dialog + this pill share one check). */
  updateAvailable?: boolean;
  /** A version is downloaded and waiting for a restart. */
  updateStaged?: boolean;
  onRestart?: () => void;
  /** Run the installer + restart (from the pill). */
  onUpgrade?: () => void;
  /** An upgrade is in flight — the pill shows a spinner + is click-inert. */
  upgrading?: boolean;
}

export function Workspace({ cwd, repoPath, root = null, updateAvailable = false, updateStaged = false, onUpgrade, onRestart, upgrading = false }: Props) {
  // Persistence key for the workspace. Prefer repoPath (a git/.hivemind
  // project); fall back to the absolute cwd so a plain folder — including
  // `$HOME` — still persists + resumes. Keyed on the absolute path (never a
  // shared `__global__` sentinel), so distinct folders never leak into each
  // other. An empty cwd (welcome/e2e bootstrap) stays transient (null) and is
  // intentionally NOT persisted.
  const persistKey = repoPath ?? (cwd || null);
  // Bootstrapped from localStorage on first render (synchronous useState
  // initializer so we never flash an empty canvas before hydrating). Reloaded
  // when the persistence key changes — see the effect below. The canvas view's
  // geometry is its own versioned blob (imported from the pre-v2 core blob once).
  const initial = useMemo(() => {
    const layout = loadLayout(persistKey);
    // What is on the canvas at load is a RESTORE: its agents take turns starting.
    markRestored((layout.tiles ?? []).map((t) => t.id));
    return layout;
  }, [persistKey]);
  const canvasInitial = useMemo(() => loadCanvasLayout(persistKey), [persistKey]);
  const cameraInitial = useMemo(() => loadCanvasCamera(persistKey), [persistKey]);

  // All open tiles, every kind, as instances. Mirror to a ref so callbacks
  // declared before later state can read the latest list without re-creating.
  const [tiles, setTiles, tilesRef] = useStateWithRef<TileInstance[]>(initial.tiles ?? []);
  // Live agent pipes (HCP hive_connect). Ephemeral.
  const [pipes, setPipes] = useState<{ src: string; dst: string }[]>([]);
  // Spawn parentage (parent → child): which agent spawned each sub-agent / workflow worker. Ephemeral.
  const [spawnLinks, setSpawnLinks] = useState<{ parent: string; child: string }[]>([]);
  // Files opened in each editor tile — tabs keyed by editor tile id.
  const [editorTabs, setEditorTabs] = useState<Record<string, string[]>>(initial.editorTabs ?? {});

  // ── canvas geometry (hosted here for the canvas view — see canvas-runtime.ts) ──
  // Runtime per-tile dimension overrides. Once the user drags a NodeResizer
  // corner we capture the committed size here; without it the memo-rebuilt node
  // spec re-applies the old style.width/height and the resize visually no-ops.
  const [sizes, setSizes, sizesRef] = useStateWithRef<Record<string, { width: number; height: number }>>(canvasInitial.sizes);
  // Explicit tile names (per tile id): a user rename, or the name a spawner chose.
  // Persisted with layout. An absent entry means "use the agent title, else the label".
  const [tileNames, setTileNames] = useState<Record<string, string>>(initial.tileNames ?? {});
  const renameTile = useCallback((id: string, name: string) => {
    const trimmed = cleanName(name);
    setTileNames((m) => {
      if (!trimmed) {
        if (!(id in m)) return m;
        const { [id]: _, ...rest } = m;
        return rest;
      }
      if (m[id] === trimmed) return m;
      return { ...m, [id]: trimmed };
    });
  }, []);
  // What each agent says it is doing, as the host reports it (its session record's title).
  // Not persisted here: the host keeps it. A name someone gave the tile takes precedence.
  const [agentTitles, setAgentTitles] = useState<Record<string, string>>({});
  const setAgentTitle = useCallback((id: string, title: string | undefined) => {
    setAgentTitles((m) => {
      if ((m[id] ?? undefined) === title) return m;
      if (title) return { ...m, [id]: title };
      const { [id]: _, ...rest } = m;
      return rest;
    });
  }, []);
  // The host sleeps and wakes agents, and says so in the layout once done.
  const sleepAgents = useSleepAgents(persistKey, (id) => {
    const t = tilesRef.current.find((x) => x.id === id);
    return t && { name: tileName(tileNames, agentTitles, t), agent: t.kind === AGENT_TILE_KIND, sleeping: !!t.sleeping };
  });
  const sleepActions = sleepAgents.actions;
  const sleepTile = sleepActions.sleep;
  // The tile's own Resume shows why it did not wake.
  const wakeTile = useCallback(async (id: string) => {
    if (!persistKey) return;
    const { woke, skipped } = await window.hive.agentWake(persistKey, id);
    if (!woke.length && skipped[0]) throw new Error(skipped[0].why);
  }, [persistKey]);
  const onNodeResizeCommit = useCallback((id: string, width: number, height: number, x?: number, y?: number) => {
    setSizes((s) => {
      const cur = s[id];
      if (cur && cur.width === width && cur.height === height) return s;
      return { ...s, [id]: { width, height } };
    });
    if (x != null && y != null) {
      // NodeResizer reports x/y RELATIVE to the parent frame for a child node,
      // but our positions map is ABSOLUTE world coords. Add the frame origin
      // back when the tile lives in one, else the tile jumps on next render.
      const fid = frameOfRef.current[id];
      const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
      const ax = fr ? fr.x + x : x;
      const ay = fr ? fr.y + y : y;
      setPositions((p) => {
        const cur = p[id];
        if (cur && cur.x === ax && cur.y === ay) return p;
        return { ...p, [id]: { x: ax, y: ay } };
      });
    }
    // Frame resize is handled reactively by the auto-fit effect.
  }, []);

  // Proportional tile scale from a terminal header's hover slider: grow the NODE
  // box by the same ratio as the font so the whole terminal scales in proportion.
  useEffect(() => {
    const onScale = (e: Event) => {
      const d = (e as CustomEvent<{ tileId: string; ratio: number }>).detail;
      if (!d?.tileId || !Number.isFinite(d.ratio) || d.ratio <= 0) return;
      const cur = sizesRef.current[d.tileId] ?? defaultTileSize(d.tileId);
      const width = Math.max(340, Math.min(4200, Math.round(cur.width * d.ratio)));
      const height = Math.max(200, Math.min(2800, Math.round(cur.height * d.ratio)));
      onNodeResizeCommit(d.tileId, width, height);
    };
    window.addEventListener("hivemind:scale-tile", onScale as EventListener);
    return () => window.removeEventListener("hivemind:scale-tile", onScale as EventListener);
  }, [onNodeResizeCommit]);

  // Tile positions (absolute world coords). Populated by drag-stop + placement.
  const [positions, setPositions, positionsRef] = useStateWithRef<Record<string, { x: number; y: number }>>(canvasInitial.positions);
  // Tiles pinned to this person's screen: theirs, kept on this device (workspace/pins.ts).
  const [pins, setPins] = useViewLayout(PINS, persistKey);
  // Pins the tiles carried while a pin was the workspace's: where this device starts, when it has none.
  useEffect(() => {
    const carried = initial.pins ?? {};
    if (Object.keys(carried).length > 0) setPins((own) => (Object.keys(own).length > 0 ? own : carried));
  }, [initial, setPins]);
  const commitPosition = useCallback((id: string, x: number, y: number) => {
    // Snap on COMMIT (not during drag) — snapping during motion teleports the
    // tile in grid steps every pointermove → feels notchy. Snap only on release.
    const sx = snapToGrid(x);
    const sy = snapToGrid(y);
    setPositions((p) => {
      const cur = p[id];
      if (cur && cur.x === sx && cur.y === sy) return p;
      return { ...p, [id]: { x: sx, y: sy } };
    });
  }, []);

  // Tile selection — the one tile that takes keyboard input, in every view.
  const [selectedTileId, setSelectedTileId, selectedTileIdRef] = useStateWithRef<string | null>(null);
  // Focus mode: fitView to one node (`.`) / fit all (Esc). Same nonce pattern
  // as focusReq so re-firing the same id still triggers.
  const [focusModeReq, setFocusModeReq] = useState<FocusModeReq>(null);
  const focusModeNonceRef = useRef(0);

  // Open a file as a tab in a SPECIFIC editor tile. The EditorTile picks the
  // newly-appended tab as active.
  const openFileInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId] ?? [];
      if (cur.includes(file)) return m;
      return { ...m, [tileId]: [...cur, file] };
    });
    setSelectedTileId(tileId);
  }, []);
  const closeTabInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId];
      if (!cur) return m;
      return { ...m, [tileId]: cur.filter((f) => f !== file) };
    });
  }, []);
  // Close a tile: end what runs in it, then drop the instance and everything keyed by it. The
  // TileHost unmounts its body. A closed tile's id never comes back, so its geometry and frame
  // membership would otherwise ride along in the saved layouts for the life of the workspace,
  // and `frameOf` keep claiming it.
  const closeTile = useCallback((id: string) => {
    const closed = tilesRef.current.find((t) => t.id === id);
    if (closed && isTerminalKind(closed.kind)) endTileSession(id, !!closed.session);
    unmarkBackgroundTile(id);
    clearWork(id); // a task queued for a tile that is gone has nowhere to land
    setTiles((ts) => ts.filter((t) => t.id !== id));
    setBrowserOpenReqs(withoutKey(id));
    setEditorTabs(withoutKey(id));
    setAgentTitles(withoutKey(id));
    setPositions(withoutKey(id));
    setSizes(withoutKey(id));
    setFrameOf(withoutKey(id));
    setPins(withoutKey(id));
    forgetStatus(id);
  }, [setPins]);


  // Frames — colored comment boxes for grouping, each optionally bound to a
  // worktree / workspace folder / remote host. frames/frameOf each expose a
  // synchronously-readable ref (updated in the setter — see useStateWithRef).
  const [frames, setFrames, framesRef] = useStateWithRef<FrameState[]>(initial.frames);
  // Re-resolve a frame's workspaceRoot when it's null but the folder now has a `.hivemind/`: on
  // load (opened before `hive init`, persisted null) and when a plugin sets issues up.
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const todo = framesRef.current.filter(
        (f) => f.workspacePath && !isRemote(f.workspacePath) && !f.workspaceRoot,
      );
      for (const f of todo) {
        try {
          const proj = await window.hive.resolveProject(f.workspacePath!);
          if (cancelled || !proj.root) continue;
          setFrames((fs) => fs.map((x) => (x.id === f.id ? { ...x, workspaceRoot: proj.root } : x)));
        } catch { /* unreadable path — leave as-is */ }
      }
    };
    void resolve();
    const onSetUp = () => { void resolve(); };
    window.addEventListener("hivemind:issues-set-up", onSetUp);
    return () => { cancelled = true; window.removeEventListener("hivemind:issues-set-up", onSetUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Explicit tile→frame membership (see PersistedLayout.frameOf). Authoritative
  // for auto-fit, parenting, and the chip strip — geometry never decides it.
  const [frameOf, setFrameOf, frameOfRef] = useStateWithRef<Record<string, string>>(initial.frameOf ?? {});
  // The board's notes, checklists, text and arrows (board-objects/). One thing is selected at a
  // time: an object or a tile.
  const deselectTile = useCallback(() => setSelectedTileId(null), [setSelectedTileId]);
  const board = useBoard({ persistKey, frames, framesRef, onSelect: deselectTile });
  const boardRef = useRef(board);
  boardRef.current = board;
  const { select: selectObject, reload: reloadBoard } = board;
  useEffect(() => { if (selectedTileId) selectObject(null); }, [selectedTileId, selectObject]);
  // What a machine is in use by, for the remove dialog: frames bound to a folder on it, and the
  // terminals in them.
  const machinesSnap = useMachines();
  const machineOwners = useMachineOwners(repoPath);
  const terminalsOn = useCallback((machineId: string) => {
    const frames = new Set(framesRef.current.filter((f) => placeOf(machinesSnap, f.workspacePath).machine?.id === machineId).map((f) => f.id));
    return { frames, terminals: tilesRef.current.filter((t) => isTerminalKind(t.kind) && frames.has(frameOfRef.current[t.id] ?? "")) };
  }, [framesRef, tilesRef, frameOfRef, machinesSnap]);
  const machineUsage = useCallback((machineId: string) => {
    const { frames, terminals } = terminalsOn(machineId);
    return { frames: frames.size, terminals: terminals.length };
  }, [terminalsOn]);
  // End them: closing a tile ends its session. A tile showing someone else's job (`hive run`,
  // another device) is only let go of — it is not ours to end.
  const endTerminalsOn = useCallback((machineId: string) => {
    for (const t of terminalsOn(machineId).terminals) closeTile(t.id);
  }, [terminalsOn, closeTile]);
  // A frame on a saved machine names it (R9): one bound by a machine's address is bound to the
  // machine, and one on a machine removed goes back to its address. A workspace joined from
  // elsewhere is its host's to bind: the machines are the host's, not these.
  const machinesKnown = useRef<MachineInfo[]>([]);
  useEffect(() => {
    const gone = machinesKnown.current.filter((m) => !machinesSnap.machines.some((x) => x.id === m.id));
    machinesKnown.current = machinesSnap.machines;
    if (!repoPath || joinedId(repoPath)) return;
    setFrames((fs) => rebindFrames(fs, machinesSnap.machines, gone));
  }, [machinesSnap, repoPath, setFrames]);
  // The frame the user most recently touched (spawned into / dragged). The
  // collision-separation pass keeps THIS frame fixed and pushes neighbours.
  const lastActiveFrameRef = useRef<string | null>(null);
  const repoPathRef = useRef(repoPath);
  useEffect(() => { repoPathRef.current = repoPath; }, [repoPath]);
  const rootRef = useRef(root);
  useEffect(() => { rootRef.current = root; }, [root]);
  // pushToast is defined far below (depends on dismissToast). bind/unbind are
  // declared above it, so reach it through a ref populated by an effect.
  const pushToastRef = useRef<((t: { tileId: string; label: string; status: TileStatusKind }) => void) | null>(null);
  // Selected frame — F2 / bring-to-front / spawn target read the ref.
  const [selectedFrameId, setSelectedFrameId, selectedFrameIdRef] = useStateWithRef<string | null>(null);

  // Latest viewport mutated on every pan tick (cheap — ref, no re-render); a pan's
  // end hands it straight to the save (`saveCamera` below), so it re-renders nothing.
  // Reload restores via react-flow's defaultViewport.
  const currentViewportRef = useRef<Viewport>(cameraInitial ?? DEFAULT_VIEWPORT);
  // The camera as loaded: it changes only when another workspace is shown.
  const [loadedCamera, setLoadedCamera] = useState<Viewport>(cameraInitial ?? DEFAULT_VIEWPORT);

  // A new box goes where the canvas says: under the pointer, or in the middle of the view when
  // the pointer is elsewhere. "arrow" starts drawing one.
  const canvasPointRef = useRef<(() => Point) | null>(null);
  const { addWidget, startArrow, update: updateBoard } = board;
  const widgetPackages = useEnabledWidgetPackages();
  useShownWorkspace(persistKey, !!joinedId(repoPath ?? null));
  useWidgetRuntime(persistKey, board.objects, widgetPackages, updateBoard);
  /** Add from the menu (or `hive ctl plugin open`); a widget's new id, when one was added. */
  // Where the pointer was when Add opened: the dialog then covers the canvas, and the pick is made on it.
  const addAtRef = useRef<Point | undefined>(undefined);
  useEffect(() => {
    const opened = () => { addAtRef.current = canvasPointRef.current?.(); };
    window.addEventListener("hivemind:open-add", opened);
    return () => window.removeEventListener("hivemind:open-add", opened);
  }, []);
  const addBoard = useCallback((kind: BoardChoice): string | undefined => {
    const at = addAtRef.current ?? canvasPointRef.current?.();
    addAtRef.current = undefined;
    const widget = kind.startsWith("widget:") ? kind.slice("widget:".length) : null;
    if (widget) {
      const pkg = widgetPackages.find((p) => p.id === widget);
      if (!pkg) return undefined;
      // A board widget goes on the board where the canvas is drawn; elsewhere, and any other, floats.
      return addWidget(pkg.id, pkg.placement === "board" && at && activeViewIdRef.current === "canvas" ? { at, size: pkg.size, lines: JSON.stringify(pkg.draw ?? null).includes('"type":"list"') } : undefined);
    }
    if (kind === "arrow") startArrow();
    return undefined;
  }, [addWidget, startArrow, widgetPackages]);
  const addBoardRef = useRef(addBoard);
  addBoardRef.current = addBoard;
  // What an agent's plugin verbs do in this window (`workspace/plugin-verbs.ts`).
  const pluginHostRef = useRef<PluginVerbHost>(null!);
  pluginHostRef.current = {
    activeView: () => activeViewIdRef.current ?? FALLBACK_VIEW_ID,
    showView: (id) => setViewMode(id),
    addWidget: (id) => addBoardRef.current(`widget:${id}` as BoardChoice),
    hasWidget: (id) => widgetPackages.some((w) => w.id === id),
    widgetRuns: (id) => !!widgetPackages.find((w) => w.id === id)?.code,
    closeTile: (id) => closeTile(id),
    widgetsOnBoard: () => board.objects.flatMap((o) => (o.kind === "widget" ? [{ id: o.id, widget: o.widget }] : [])),
    removeWidget: (id) => board.remove(id),
  };

  // Reload when the repo changes — each repo has its own workspace + view
  // layouts. Skip on first mount (initial values already came from the memos).
  const lastRepoRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRepoRef.current === undefined) {
      lastRepoRef.current = persistKey;
      return;
    }
    if (lastRepoRef.current === persistKey) return;
    lastRepoRef.current = persistKey;
    const next = loadLayout(persistKey);
    const nextCanvas = loadCanvasLayout(persistKey);
    const nextCamera = loadCanvasCamera(persistKey);
    setSizes(nextCanvas.sizes);
    setPositions(nextCanvas.positions);
    setFrames(next.frames);
    setTileNames(next.tileNames ?? {});
    setTiles(next.tiles ?? []);
    setEditorTabs(next.editorTabs ?? {});
    setFrameOf(next.frameOf ?? {});
    reloadBoard(persistKey, next.frames);
    if (nextCamera) { currentViewportRef.current = nextCamera; setLoadedCamera(nextCamera); }
  }, [persistKey, reloadBoard]);

  // Persist — trailing-debounced (250ms) so a drag's per-drop setPositions
  // doesn't JSON.stringify a blob on the main thread per commit; flushed on
  // repo switch (under the old key), unmount and beforeunload by
  // useDebouncedSave (the ONE mechanism every layout blob uses). Three blobs, three
  // triggers: the core blob rewrites on structural edits only, a drop touches just
  // the canvas view's places, and a pan just this person's camera.
  const coreSnap = useMemo(() => ({ frames, tileNames, tiles, editorTabs, frameOf }), [frames, tileNames, tiles, editorTabs, frameOf]);
  const geometry = useMemo(() => ({ positions, sizes }), [positions, sizes]);
  const { flush: flushCore } = useDebouncedSave(persistKey, coreSnap, useCallback((key: string, v: typeof coreSnap) => saveLayout(key, v), []));
  // Main acts on the workspace this window shows, in the frame the user is in, when the control
  // plane's caller is in no tile.
  const userFrame = selectedFrameId ?? (selectedTileId ? frameOf[selectedTileId] ?? null : null);
  useEffect(() => showWorkspace(persistKey, userFrame), [persistKey, userFrame]);
  // Another writer changed this workspace's core layout (the control plane named or closed a
  // tile): write what this window has yet to save, which the store applies as this window's change
  // alone, then take the layout as stored, keeping what this window changed since. A tile that
  // writer closed is closed here as its × closes it, which also ends a session still starting.
  // The canvas's places and the board merge the same way (another window moved a tile, added a note).
  const { flush: flushGeometry } = useDebouncedSave(persistKey, geometry, useCallback((key: string, v: typeof geometry) => saveViewLayout(CANVAS_LAYOUT, key, v), []));
  const { merge: mergeBoard } = board;
  useEffect(() => onStoreChange(({ repo, part, objects }) => {
    if (repo !== persistKey) return;
    if (part === "core") {
      flushCore();
      const stored = reloadLayout(repo);
      setFrames(stored.frames);
      setTileNames(stored.tileNames);
      setTiles(stored.tiles);
      setEditorTabs(stored.editorTabs);
      setFrameOf(stored.frameOf);
      for (const id of stored.closed) closeTile(id);
    } else if (part === `view:${CANVAS_LAYOUT.viewId}`) {
      flushGeometry();
      const stored = reloadCanvasLayout(repo);
      setPositions(stored.positions);
      setSizes(stored.sizes);
    } else if (part === "board") {
      mergeBoard(objects);
    }
  }), [persistKey, flushCore, flushGeometry, mergeBoard, closeTile, setFrames, setTiles, setFrameOf, setPositions, setSizes]);
  const { schedule: saveCamera } = useDebouncedSave(persistKey, loadedCamera, useCallback((key: string, v: Viewport) => saveViewLayout(CANVAS_CAMERA, key, v), []));

  // Viewport-focus request: resolve the target's CENTER from our own state
  // (positions/sizes/frames) and hand absolute coords to <FocusOnTile>. Works
  // even when the node hasn't been DOM-measured yet or is culled off-screen.
  const [focusReq, setFocusReq] = useState<FocusReq>(null);
  const focusTile = useCallback(
    (id: string, opts?: { exact?: boolean }) => {
      const frame = framesRef.current.find((f) => f.id === id);
      let cx: number, cy: number, w: number, h: number;
      if (frame) {
        cx = frame.x + frame.w / 2;
        cy = frame.y + frame.h / 2;
        w = frame.w;
        h = frame.h;
      } else {
        const p = positionsRef.current[id];
        if (!p) return;
        const kind = tilesRef.current.find((t) => t.id === id)?.kind;
        const s = sizesRef.current[id] ?? (kind ? defaultSizeForKind(kind) : defaultTileSize(id));
        cx = p.x + s.width / 2;
        cy = p.y + s.height / 2;
        w = s.width;
        h = s.height;
      }
      // Text is only sharp at exactly 100%, so a tile always lands there; only a frame zooms to fit.
      setFocusReq((prev) => ({ id, cx, cy, w, h, n: (prev?.n ?? 0) + 1, exact: opts?.exact ?? !frame }));
    },
    [],
  );

  // Frame CRUD + opt-in arrange + the reactive auto-fit effect. See useFrameOps.
  const {
    addFrame, updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, moveFrame, bringFrameToFront,
  } = useFrameOps({
    repoPath, positions, sizes, tiles, frameOf, boxes: board.objects,
    framesRef, tilesRef, frameOfRef, positionsRef, sizesRef, lastActiveFrameRef, boardRef: board.objectsRef,
    setFrames, setFrameOf, setPositions, setSelectedFrameId, focusTile, shiftBoxes: board.shiftFrames, placeBoxes: board.place,
  });

  // Worktree + workspace-zone lifecycle (IPC, in-flight guard, detach confirm).
  const {
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace, bindRemote,
  } = useWorktrees({
    framesRef, tilesRef, positionsRef, sizesRef, frameOfRef, repoPathRef,
    lastActiveFrameRef, pushToastRef, setFrames, setFrameOf, setSelectedFrameId,
    focusTile, closeTile,
  });

  // Topmost-frame-wins point membership for drops (pure — see frameAtPoint).
  const sortedFrames = useMemo(() => [...frames].sort((a, b) => b.z - a.z), [frames]);
  const parentFrameOf = useCallback(
    (cx: number, cy: number): { parentId: string; fx: number; fy: number } | null => {
      const r = frameAtPoint(sortedFrames, cx, cy);
      return r ? { parentId: r.id, fx: r.x, fy: r.y } : null;
    },
    [sortedFrames],
  );

  // Which tile ids fall inside each frame — drives the chip strip in FrameNode.
  const frameTiles = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of tiles) {
      const fid = frameOf[t.id];
      if (!fid) continue;
      const arr = map.get(fid) ?? [];
      arr.push(t.id);
      map.set(fid, arr);
    }
    return map;
  }, [frameOf, tiles]);

  // Deleting a frame that holds tiles asks first: keep them (loose) or close them with it. Its
  // worktree sub-frames go with it, so their tiles count too.
  const [frameDeleteAsk, setFrameDeleteAsk] = useState<FrameDeleteAsk | null>(null);
  const tilesInFrame = useCallback((id: string) => {
    const ids = new Set([id, ...framesRef.current.filter((f) => f.parentFrameId === id).map((f) => f.id)]);
    return tilesRef.current.filter((t) => ids.has(frameOfRef.current[t.id] ?? ""));
  }, []);
  const requestDeleteFrame = useCallback((id: string) => {
    const held = tilesInFrame(id);
    if (!held.length) { deleteFrame(id); return; }
    const title = framesRef.current.find((f) => f.id === id)?.title || "this frame";
    setFrameDeleteAsk({ frameId: id, title, tiles: held.length, agents: held.filter((t) => t.kind === AGENT_TILE_KIND).length });
  }, [tilesInFrame, deleteFrame]);
  const onFrameDeleteChoice = useCallback((choice: "cancel" | "keep" | "close") => {
    const ask = frameDeleteAsk;
    setFrameDeleteAsk(null);
    if (!ask || choice === "cancel") return;
    if (choice === "close") for (const t of tilesInFrame(ask.frameId)) closeTile(t.id);
    deleteFrame(ask.frameId);
  }, [frameDeleteAsk, tilesInFrame, closeTile, deleteFrame]);

  // ── view-agnostic listing (Layers rail, tab strip, 3D labels …) ────────────
  const layerFrames: LayerFrame[] = useMemo(
    () => frames.map((f) => ({
      id: f.id, title: f.title, color: f.color,
      parentFrameId: f.parentFrameId, branch: f.parentFrameId ? f.branch : undefined,
      remote: isRemote(f.workspacePath),
      remoteUri: isRemote(f.workspacePath) ? f.workspacePath : undefined,
      folder: (f.worktreePath ?? f.workspacePath)?.split("/").filter(Boolean).pop(),
      ...(!isRemote(f.workspacePath) && (f.worktreePath ?? f.workspacePath) ? { path: (f.worktreePath ?? f.workspacePath)! } : {}),
    })),
    [frames],
  );
  // Agents arrive with the first scan, after the layout: re-derive each tile's agent then.
  const agentCatalog = useAgents();
  const layerTiles: LayerTile[] = useMemo(() => {
    const out: LayerTile[] = [];
    const fo = frameOf;
    const starter = new Map(spawnLinks.map((l) => [l.child, l.parent]));
    for (const t of tiles) {
      // Same effective-repo rule as the surface builder: a worktree/workspace
      // frame can supply the repo even when the workspace has no global one.
      const owner = fo[t.id] ? frames.find((f) => f.id === fo[t.id]) : undefined;
      const effRepo = owner?.worktreePath ?? owner?.workspacePath ?? repoPath ?? null;
      if (tileKind(t.kind).needsRepo && !effRepo) continue;
      const kind = t.kind;
      const agent = agentOfTile(t);
      const parent = starter.get(t.id);
      out.push({ id: t.id, kind, name: tileName(tileNames, agentTitles, t), frameId: fo[t.id] ?? null, agent, ...(parent ? { parent } : {}), ...(t.sleeping ? { sleeping: true as const } : {}) });
    }
    return out;
  }, [tiles, repoPath, frameOf, frames, tileNames, agentTitles, agentCatalog, spawnLinks]);

  // ── active view (plugin) ───────────────────────────────────────────────────
  // The stored id (view-mode-store, shared with Settings ▸ View and ⌘E) is a
  // plain string so a view can be added/removed without a schema change;
  // resolveViewId maps unknown ids to the fallback.
  // Community views (sandboxed packages) come and go with the repo; the
  // registry is an external store, so this also re-renders the switchers.
  useViews();
  useEffect(() => {
    const viewRoot = joinedId(repoPath) ? repoPath : root;
    void loadCommunityViews(viewRoot);
    const reload = () => { void loadCommunityViews(viewRoot); };
    window.addEventListener("hivemind:reload-views", reload);
    const offBack = window.hive.onSharedStatus((workspace, status) => {
      if (`hive://${workspace}` === viewRoot && status.state === "connected") reload();
    });
    return () => { window.removeEventListener("hivemind:reload-views", reload); offBack(); };
  }, [root, repoPath]);
  // With the root, or agents the repo ships are left out.
  useEffect(() => { void syncAgentPlugins(root); }, [root]);
  // Catalog agents whose CLI this machine has are added once the workspace is up and its
  // restored tiles have started, so the network and each CLI's `--version` stay off both.
  //
  // Two things this must survive, because together they strand a machine: an agent this
  // version cannot load is a tile that may never finish starting (so "boot is idle" never
  // comes), and the registry is on the other side of someone's network (so the check can
  // fail). Waiting is therefore capped, and a check that changed nothing while an installed
  // agent is still broken is tried again.
  useEffect(() => {
    let live = true;
    const capped = () => Promise.race([whenBootIdle(), new Promise<void>((r) => setTimeout(r, BOOT_WAIT_CAP_MS))]);
    const check = async (attempt: number): Promise<void> => {
      if (!live) return;
      const { added, updated } = await window.hive.autoInstallAgents();
      if (!added.length && !updated.length && attempt < CATALOG_RETRIES && agentScanProblems().length) {
        setTimeout(() => void check(attempt + 1), CATALOG_RETRY_MS);
      }
      return announce({ added, updated });
    };
    const timer = setTimeout(() => void capped().then(() => live ? check(0) : undefined).catch(() => {}), 4000);
    const announce = ({ added, updated }: { added: Array<{ id: string; label: string; does: string[] }>; updated: Array<{ id: string; label: string }> }) => {
      if (updated.length) {
        void syncAgentPlugins();
        toast.success(`Updated ${updated.map((a) => a.label).join(", ")} for this version of Hivemind.`);
      }
      if (!added.length) return;
      void syncAgentPlugins();
      const toastId = toast.success(`Added ${added.map((a) => a.label).join(", ")} — found on this machine.`, {
        // The registry review (by pull request) stands in for a per-user one, so what each
        // agent can do is disclosed here instead of gating the install. Remove reuses the
        // the Remove path in Settings ▸ Plugins: uninstall + decline, so it is never re-added.
        description: (
          <div>{added.map((a) => (
            <div key={a.id} className="agent-added">
              <div className="agent-added-head">
                <span className="agent-added-label">{a.label}</span>
                <Button size="sm" variant="outline" aria-label={`Remove ${a.label}`} className="agent-added-remove"
                  onClick={() => void window.hive.removeAgent(a.id)
                    .then(() => { void syncAgentPlugins(); toast.dismiss(toastId); })
                    .catch(() => toast.error(`Could not remove ${a.label}.`))}>
                  Remove
                </Button>
              </div>
              {a.does.map((d) => <div key={d} className="agent-added-does">{d}</div>)}
            </div>
          ))}</div>
        ),
        duration: 15000,
        action: { label: "Agents", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: { page: "agents" } })) },
      });
    };
    return () => { live = false; clearTimeout(timer); };
  }, []);
  const activeViewId = resolveViewId(useViewMode());
  useSharedDefaultView(persistKey, activeViewId);
  const activeViewIdRef = useRef(activeViewId);
  activeViewIdRef.current = activeViewId;
  // View protocol 1.3: the event hub hears every tile whatever view is active. Off the first
  // paint — the status bus replays current statuses to it when it starts.
  const [viewHost, setViewHost] = useState<typeof import("./workspace/view-services") | null>(null);
  const viewHostRef = useRef(viewHost);
  viewHostRef.current = viewHost;
  useEffect(() => {
    let live = true;
    void import("./workspace/view-services").then((m) => { m.startViewHost(); if (live) setViewHost(m); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!viewHost) return;
    viewHost.viewEvents.setWorkspace(persistKey, tiles.map((t) => {
      const frame = frameOf[t.id] ? frames.find((f) => f.id === frameOf[t.id]) : undefined;
      const machine = frame ? frameMachine(machinesSnap, frame.workspacePath, machineOwners) : undefined;
      const agent = agentOfTile(t);
      return {
        id: t.id, frameId: frameOf[t.id] ?? null, kind: t.kind, name: tileNames[t.id] ?? t.label,
        ...(frame ? { frameTitle: frame.title } : {}), ...(agent ? { agent } : {}),
        ...(machine && machine.state !== "online" ? { unwatched: true } : {}),
      };
    }), spawnLinks);
  }, [viewHost, persistKey, tiles, frameOf, frames, tileNames, machinesSnap, machineOwners, spawnLinks]);
  // Host chrome + wallpaper policy come from the active view's preference.
  const settings = useSettings();
  const chrome = useMemo(() => {
    const base = resolveChrome(activeViewId ? getView(activeViewId) : null);
    const over = activeViewId ? settings.views.chrome[activeViewId] : undefined;
    return over?.island ? { ...base, island: over.island } : base;
  }, [activeViewId, settings.views.chrome]);
  useEffect(() => { setWallpaperActive(chrome.wallpaper); }, [chrome.wallpaper]);
  const pluginScene = activeViewId ? getView(activeViewId)?.source === "community" : false;
  useEffect(() => { setPluginScene(pluginScene); }, [pluginScene]);
  // Crash bookkeeping: which view failed (+ why) and a retry counter that
  // remounts the boundary. A failure in a non-fallback view auto-switches to the
  // fallback with a toast; a failure IN the fallback shows the failure panel.
  const [viewFailure, setViewFailure] = useState<{ id: string; error: Error } | null>(null);
  const [viewAttempt, setViewAttempt] = useState(0);
  useEffect(() => { setViewFailure(null); }, [activeViewId]); // leaving a crashed view clears its record
  const switchView = useCallback((id: string) => {
    setViewFailure(null);
    setViewMode(resolveViewId(id));
  }, []);
  const onViewError = useCallback((id: string, error: Error) => {
    const fallback = resolveViewId(FALLBACK_VIEW_ID);
    if (fallback && fallback !== id) {
      toast.error(`The ${getView(id)?.label ?? id} view crashed — switched to ${getView(fallback)?.label ?? fallback}. Your tiles are untouched.`);
      setViewMode(fallback);
    } else {
      setViewFailure({ id, error });
    }
  }, []);

  // Which agent the tool island's spawn button creates (claude / codex / …), and the agents a
  // prompt may start, that one first. Undefined when the catalog is empty.
  const { ordered: readyAgents, first: agentSel } = useReadyAgents();
  const setAgentSel = useCallback((id: string) => patchSettings("agents.defaultAgent", id), []);
  const agentSelRef = useRef(agentSel);
  useEffect(() => { agentSelRef.current = agentSel; }, [agentSel]);

  // Spawn-target picker: when 2+ workspaces (base + workspace-zone frames) live
  // on the canvas, ask WHERE a new claude should run instead of guessing.
  const [spawnPick, setSpawnPick] = useState<({ kind: TileKind } & SpawnOpts) | null>(null);
  const browserReqSeq = useRef(0);
  const [browserOpenReqs, setBrowserOpenReqs] = useState<Record<string, { url: string; seq: number }>>({});
  // Text awaiting a claude target — set when something wants to deliver a prompt
  // ("Work on this", diff "send review") and 1+ claude tiles exist.
  const [agentPick, setAgentPick] = useState<{ text: string } | null>(null);
  // The Machines dialog: `hivemind:attach-remote` picks where a frame runs, `hivemind:machines` opens it for anything else.
  const [machinesReq, setMachinesReq] = useState<MachinesRequest | null>(null);
  useEffect(() => {
    const onAttach = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId: string }>).detail?.frameId;
      if (fid) setMachinesReq({ kind: "pick", frameId: fid });
    };
    const onMachines = (e: Event) => setMachinesReq((e as CustomEvent<MachinesRequest>).detail);
    window.addEventListener("hivemind:attach-remote", onAttach as EventListener);
    window.addEventListener("hivemind:machines", onMachines as EventListener);
    return () => {
      window.removeEventListener("hivemind:attach-remote", onAttach as EventListener);
      window.removeEventListener("hivemind:machines", onMachines as EventListener);
    };
  }, []);

  // `+` in the Layers rail ("add project"): a NEW frame bound to a folder,
  // so it joins the rail alongside the current project instead of switching it.
  useEffect(() => {
    const onAdd = () => void bindWorkspace(addFrame());
    window.addEventListener("hivemind:add-project", onAdd);
    return () => window.removeEventListener("hivemind:add-project", onAdd);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Git commit/sync modal — open for a specific repo (a frame's worktree /
  // workspace / base repo), via `hivemind:frame-git` {frameId | repoPath}.
  const [gitModalRepo, setGitModalRepo] = useState<string | null>(null);
  useEffect(() => {
    const onGit = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId?: string; repoPath?: string }>).detail;
      if (fid?.repoPath) { setGitModalRepo(fid.repoPath); return; }
      if (fid?.frameId) {
        const f = framesRef.current.find((x) => x.id === fid.frameId);
        const repo = f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
        if (repo) setGitModalRepo(repo);
      }
    };
    window.addEventListener("hivemind:frame-git", onGit as EventListener);
    return () => window.removeEventListener("hivemind:frame-git", onGit as EventListener);
  }, []);

  // Tile spawning + in-frame placement. See useSpawn.
  const { spawnTile, spawnDefaultAgent, spawnAgent, spawnVis, spawnInto, frameOpen, openPlanReview, placeArrived } = useSpawn({
    repoPath,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef, boardRef: board.objectsRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile, openFileInTile, renameTile,
  });
  // Tiles the control plane opens, which its host starts: announced before they reach the layout
  // (whether to bring each forward), then laid out as they arrive.
  const arrivals = useRef(new Map<string, Pick<TileOpened, "background" | "near" | "by">>());
  useEffect(() => {
    const off = window.hive.onHcpSpawned(({ tileId, repo, background, near, by }) => {
      if (repo !== persistKey) return;
      if (background) markBackgroundTile(tileId);
      arrivals.current.set(tileId, { background, near, by });
    });
    return () => { off(); arrivals.current.clear(); };
  }, [persistKey]);
  useEffect(() => {
    for (const [id, at] of arrivals.current) {
      if (!tiles.some((t) => t.id === id)) continue;
      arrivals.current.delete(id);
      placeArrived(id, at);
    }
  }, [tiles, placeArrived]);
  // A session already running on a machine (the frame's machine chip) opens as a terminal in that frame.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const { frameId, session } = (e as CustomEvent<{ frameId: string; session: SessionSummary }>).detail;
      spawnTile("shell", frameId, { session: { id: session.id, cmd: session.cmd, args: session.args, label: session.title || session.cmd } });
    };
    window.addEventListener("hivemind:open-session", onOpen as EventListener);
    return () => window.removeEventListener("hivemind:open-session", onOpen as EventListener);
  }, [spawnTile]);

  // Rail context-menu actions — the SAME surface the on-canvas frame header
  // exposes, reused from the Layers rail in every view.
  const gitPushMut = useGitPush();
  const gitPullMut = useGitPull();
  const repoOfFrame = useCallback((frameId: string): string | null => {
    const f = framesRef.current.find((x) => x.id === frameId);
    return f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
  }, []);
  const frameActions = useMemo(() => ({
    onOpenInFrame: (frameId: string, kind: string, launch?: Record<string, string>) => frameOpen(frameId, kind, launch),
    onCreateWorktree,
    onAttachWorktree,
    onBindWorkspace: (frameId: string) => bindWorkspace(frameId),
    onAttachRemote: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId } })),
    onArrange: (frameId: string, mode: "columns" | "rows" | "grid") => arrangeFrame(frameId, mode),
    onRename: (frameId: string, title: string) => updateFrameTitle(frameId, title),
    onColor: (frameId: string, color: string) => updateFrameColor(frameId, color),
    onDelete: (frameId: string) => requestDeleteFrame(frameId),
    onDetachWorktree: (frameId: string) => unbindBranch(frameId),
    onAddInFrame: (frameId: string) => openAdd(frameId),
    onUnbindWorkspace: (frameId: string) => unbindWorkspace(frameId),
    onGit: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:frame-git", { detail: { frameId } })),
    onPush: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPushMut.mutate({ repoPath: r }); },
    onPull: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPullMut.mutate({ repoPath: r }); },
    onSleep: (frameId: string) => void sleepActions.sleep(frameId),
    onWake: (frameId: string) => void sleepActions.wake(frameId),
    agentsIn: (frameId: string) => {
      const within = new Set([frameId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const f of framesRef.current) if (f.parentFrameId && within.has(f.parentFrameId) && !within.has(f.id)) { within.add(f.id); grew = true; }
      }
      const agents = tilesRef.current.filter((t) => t.kind === AGENT_TILE_KIND && within.has(frameOfRef.current[t.id] ?? ""));
      const asleep = agents.filter((t) => t.sleeping).length;
      return { awake: agents.length - asleep, asleep };
    },
    repoPathForFrame: (frameId: string): string | null => {
      const f = framesRef.current.find((x) => x.id === frameId);
      return f?.worktreePath ?? f?.workspacePath ?? repoPath ?? null;
    },
    // Depend on the stable `.mutate` refs, NOT the mutation objects — those are
    // fresh on every isPending tick and would re-render every rail consumer.
  }), [frameOpen, onCreateWorktree, onAttachWorktree, bindWorkspace, arrangeFrame, updateFrameTitle, updateFrameColor, requestDeleteFrame, unbindBranch, unbindWorkspace, repoPath, repoOfFrame, gitPushMut.mutate, gitPullMut.mutate, sleepActions]);
  const openFileFromTerminal = useCallback((sourceTileId: string, path: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = pickEditorTile(tilesRef.current, frameOfRef.current, sourceFrameId);
    if (existing) {
      openFileInTile(existing, path);
      setTimeout(() => { setSelectedTileId(existing); focusTile(existing); }, 0);
      return;
    }
    // No editor in that frame: the fresh one must still open the file the user
    // clicked — spawnTile mints its id, so the path rides in `opts.file`.
    const kind = kindsThatOpenNow("file")[0];
    if (kind) spawnTile(kind, sourceFrameId ?? null, { file: path });
  }, [openFileInTile, focusTile, spawnTile]);

  const openUrlInBrowser = useCallback((sourceTileId: string, url: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = tilesRef.current.find((t) => (
      tileKind(t.kind).opens?.includes("url") && (!sourceFrameId || frameOfRef.current[t.id] === sourceFrameId)
    ));
    if (existing) {
      const browserFrameId = frameOfRef.current[existing.id] ?? null;
      const seq = ++browserReqSeq.current;
      setBrowserOpenReqs((m) => ({ ...m, [existing.id]: { url, seq } }));
      // Defer selection past the click-bubble: onNodeClick fires on the terminal
      // node after our handler and would re-select it, clobbering our selection.
      setTimeout(() => {
        if (browserFrameId) setSelectedFrameId(browserFrameId);
        setSelectedTileId(existing.id);
        focusTile(existing.id);
      }, 0);
      return;
    }
    const kind = kindsThatOpenNow("url")[0];
    if (kind) spawnTile(kind, sourceFrameId ?? null, { url });
    // No tile here opens addresses: the system's browser does (main opens only http(s)).
    else window.open(url, "_blank", "noopener,noreferrer");
  }, [focusTile, spawnTile]);

  // Plan review: an agent waits on a person's review of its plan (M2). Every window showing the
  // agent opens the review beside it, on every machine the workspace is shared with, and the ones
  // waiting when it opens; once anyone answers, or the agent stops waiting, it closes, and the
  // others are told who answered. The agent list says it all (`waiting.plan`).
  useEffect(() => {
    if (!persistKey) return undefined;
    let live = true;
    let me: string | null = null;
    const reviewed = new Set<string>();
    const reviewOf = (agent: string) => tilesRef.current.find((t) => t.kind === "planReview" && t.review?.agentTileId === agent);
    const seen = (a: AgentItem | { gone: string }): void => {
      const agent = "gone" in a ? a.gone : a.tile;
      const plan = "gone" in a || a.waiting?.kind !== "plan" || a.waiting.plan === undefined ? null : { since: a.waiting.since, plan: a.waiting.plan };
      const open = reviewOf(agent);
      if (open && open.review?.since !== plan?.since) closeTile(open.id);
      if (!plan || (open && open.review?.since === plan.since) || !tilesRef.current.some((t) => t.id === agent)) return;
      reviewed.add(agent);
      openPlanReview({ agentTileId: agent, since: plan.since, plan: plan.plan });
    };
    void window.hive.identity().then((id) => { me = id?.personId ?? null; }, () => {});
    void window.hive.agentList(persistKey).then(({ agents }) => { if (live) agents.forEach(seen); }, () => {});
    const offChanged = window.hive.onAgentChanged((repo, change) => { if (repo === persistKey) seen("agent" in change ? change.agent : { gone: change.gone }); });
    const offEvent = window.hive.onAgentEvent((repo, e) => {
      if (repo !== persistKey || e.kind !== "answered" || !reviewed.delete(e.tile)) return;
      if (e.by && e.by.person !== me) toast(`${e.by.name || "Someone"} ${e.detail === "allow" ? "approved the plan" : "asked for changes to the plan"}`);
    });
    return () => { live = false; offChanged(); offEvent(); };
  }, [persistKey, openPlanReview, closeTile]);

  // HCP control plane: main forwards a verb only a window can carry out (focus a tile, a view's
  // event). Execute it and reply with the result/error.
  useEffect(() => {
    const reply = window.hive.hcpResult;
    if (!reply) return;
    const off = window.hive.onHcpCommand(async (cmd) => {
      try {
        const p = (cmd.params ?? {}) as Record<string, unknown>;
        if (isPluginVerb(cmd.method)) {
          await reply(cmd.id, true, await pluginVerb(cmd.method, p, pluginHostRef.current));
          return;
        }
        switch (cmd.method) {
          case "view.emit": {
            const ev = p as { name: string; data: never; view?: string; from: "shell" | { tileId: string } };
            const active = activeViewIdRef.current ?? FALLBACK_VIEW_ID;
            const vh = viewHostRef.current;
            if (!vh) throw new Error("views are still starting");
            const { event, delivered } = vh.viewEvents.emitCustom(ev.name, ev.data, ev.from, ev.view);
            const reason = delivered ? null : ev.view && ev.view !== active ? "not-active" : "no-listener";
            await reply(cmd.id, true, { ok: true, id: event.id, delivered, view: active, ...(reason ? { reason, buffered: true } : {}) });
            break;
          }
          case "views.rescan": {
            const r = await loadCommunityViews(rootRef.current);
            await reply(cmd.id, true, { registered: r.registered, refused: r.refused });
            break;
          }
          case "agents.rescan": {
            // `hive agents install|remove`
            const problems = await syncAgentPlugins(rootRef.current);
            await reply(cmd.id, true, { problems });
            break;
          }
          case "tile.focus": {
            const id = String(p.tileId ?? "");
            setSelectedTileId(id);
            focusTile(id);
            await reply(cmd.id, true, { ok: true });
            break;
          }
          case "tile.look": {
            const seen = await lookAt(String(p.tileId ?? ""), (id) => { setSelectedTileId(id); focusTile(id); });
            await reply(cmd.id, true, seen);
            break;
          }
          default:
            await reply(cmd.id, false, undefined, `unknown renderer verb: ${cmd.method}`);
        }
      } catch (e) {
        // The code (NOT_FOUND, TIMEOUT …) is what the agent's exit status is made from.
        const code = (e as { code?: unknown } | null)?.code;
        await reply(cmd.id, false, undefined, (e as Error)?.message ?? "renderer error", typeof code === "string" ? code : undefined);
      }
    });
    return off;
  }, [focusTile]);

  // Agent links, from the host: the ones there are now (drawn before this window opened), then
  // every change. The answer already counts any change pushed before it.
  useEffect(() => {
    let live = true;
    void window.hive.hcpLinks().then(({ pipes: p, spawns }) => {
      if (!live) return;
      setPipes(p);
      setSpawnLinks(spawns);
    });
    return () => { live = false; };
  }, []);
  // HCP pipes. Add on connect; on disconnect remove the one pipe (dst set) or all of src's (dst null).
  useEffect(() => {
    return window.hive.onHcpPipe((ev) => {
      setPipes((cur) => {
        if (ev.connected && ev.dst) {
          if (cur.some((p) => p.src === ev.src && p.dst === ev.dst)) return cur;
          return [...cur, { src: ev.src, dst: ev.dst }];
        }
        return cur.filter((p) => p.src !== ev.src || (ev.dst != null && p.dst !== ev.dst));
      });
    });
  }, []);

  // HCP spawn parentage.
  useEffect(() => {
    return window.hive.onHcpSpawn((ev) => {
      setSpawnLinks((cur) => {
        if (ev.connected && ev.parent) {
          if (cur.some((l) => l.parent === ev.parent && l.child === ev.child)) return cur;
          return [...cur, { parent: ev.parent, child: ev.child }];
        }
        return cur.filter((l) => l.child !== ev.child && l.parent !== ev.child);
      });
    });
  }, []);

  // The window says which tile you are on, by the name every surface uses.
  useEffect(() => {
    const t = selectedTileId ? tiles.find((x) => x.id === selectedTileId) : undefined;
    const n = t ? tileName(tileNames, agentTitles, t) : undefined;
    document.title = n ? `${n} — hivemind` : "hivemind";
  }, [selectedTileId, tiles, tileNames, agentTitles]);
  // Agent sessions' statuses, from the host: everything there is, then every change.
  useEffect(() => {
    const off = window.hive.onHcpStatus((ev) => { setHostedStatus(ev.tileId, ev.status); setAgentTitle(ev.tileId, ev.status.title); });
    void window.hive.hcpStatusAll().then((all) => { for (const { tileId, status } of all) { setHostedStatus(tileId, status); setAgentTitle(tileId, status.title); } });
    return off;
  }, []);

  // Deliver a prompt to an agent with a TARGET PICKER. 0 agent tiles → start the agent a new
  // tile starts, carrying the prompt; 1+ → picker (the chosen tile, or a new one of an agent).
  const deliverToAgent = useCallback((text: string, target: string) => {
    if (target.startsWith(NEW_AGENT_ROW)) { spawnDefaultAgent(undefined, text, target.slice(NEW_AGENT_ROW.length) || undefined); return; }
    window.dispatchEvent(new CustomEvent("hivemind:send-to-agent", { detail: { text, target } }));
    setSelectedTileId(target);
    focusTile(target);
  }, [spawnDefaultAgent, focusTile]);
  useEffect(() => {
    const onDeliver = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      const agentTiles = tilesRef.current.filter((t) => t.kind === AGENT_TILE_KIND);
      if (agentTiles.length === 0) { spawnDefaultAgent(undefined, text); return; }
      setAgentPick({ text });
    };
    window.addEventListener("hivemind:deliver-to-agent", onDeliver as EventListener);
    return () => window.removeEventListener("hivemind:deliver-to-agent", onDeliver as EventListener);
  }, [spawnDefaultAgent]);

  // Spawn the island's CURRENTLY-selected agent (key "2").
  const spawnSelectedAgent = useCallback(() => {
    const a = agentById(agentSelRef.current);
    if (!a) { noAgentInstalled(); return; }
    spawnAgent(a);
  }, [spawnAgent]);
  const spawnBrowser = useCallback(() => spawnInto("browser"), [spawnInto]);

  // Keyboard shortcuts + menu event listeners. See useCanvasShortcuts.
  useCanvasShortcuts({
    repoPath, spawnDefaultAgent, spawnSelectedAgent, spawnVis, spawnBrowser, addFrame, frameOpen, focusTile, closeTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef, boardRef, addBoard,
    onCanvas: () => (activeViewIdRef.current ?? FALLBACK_VIEW_ID) === "canvas",
  });

  // Pinning captures the tile's SCREEN rect so the floating panel opens where the tile is.
  const pinnedIds = useMemo(() => new Set(Object.keys(pins)), [pins]);
  const togglePin = useCallback((id: string, rect: PinRect) => {
    setPins((all) => {
      if (all[id]) return withoutKey<(typeof all)[string]>(id)(all);
      const anchor = clampAnchor(
        { sx: rect.sx, sy: rect.sy },
        { w: rect.w, h: rect.h },
        { w: window.innerWidth, h: window.innerHeight },
      );
      return { ...all, [id]: { anchor, size: { w: rect.w, h: rect.h } } };
    });
  }, [setPins]);
  const onPinChange = useCallback((id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => {
    setPins((all) => {
      const pin = all[id];
      return pin ? { ...all, [id]: { anchor: patch.anchor ?? pin.anchor, size: patch.size ?? pin.size } } : all;
    });
  }, [setPins]);
  // A pinned panel lives in SCREEN pixels — re-clamp every pin on window resize
  // so a shrunk window can't strand one off-screen (the anchor is persisted).
  useEffect(() => {
    const reclamp = () => {
      const win = { w: window.innerWidth, h: window.innerHeight };
      setPins((all) => {
        let moved = false;
        const next = { ...all };
        for (const [id, pin] of Object.entries(all)) {
          const c = clampAnchor(pin.anchor, pin.size ?? PIN_SIZE, win);
          if (c.sx === pin.anchor.sx && c.sy === pin.anchor.sy) continue;
          moved = true;
          next[id] = { ...pin, anchor: c };
        }
        return moved ? next : all;
      });
    };
    reclamp(); // also rescues pins already stranded by a resize while closed
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [setPins]);

  // Theme is a global app pref persisted by theme-store; push it into the DOM once.
  useEffect(() => { applyTheme(); }, []);

  // ── auto-pan to newly-spawned tiles ───────────────────────────────────────
  // Framed spawns are already selected+focused by placeInFrame (the single
  // authority); fire here only for a LOOSE tile so we don't double-animate.
  const prevExtrasLen = useRef(tiles.length);
  useEffect(() => {
    if (tiles.length > prevExtrasLen.current) {
      const last = tiles[tiles.length - 1];
      if (last && !frameOfRef.current[last.id]) {
        setSelectedTileId(last.id);
        focusTile(last.id);
      }
    }
    prevExtrasLen.current = tiles.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, focusTile]);

  const { toasts, dismissToast, markSeen, selectedTileIdsRef } = useAgentAwareness({
    pushToastRef, frameOfRef, framesRef,
  });

  // Canvas drop handling (membership on drop, frame moves). The canvas view
  // strips its `.canvas-dragging` class before delegating, so no-op here.
  const noopClearDragging = useCallback(() => {}, []);
  const handleNodeDragStop = useNodeDragStop({
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging: noopClearDragging,
    moveBox: board.moveTo, shiftBoxes: board.shiftFrames,
  });
  // Re-lay out, never remove. This used to clear every frame and tile, which left each agent
  // and terminal running in the daemon with no tile to reach it by. Now: tiles back to their
  // default size, each frame's tiles on a grid, then the whole canvas in view. Worktree frames
  // go first — a parent's arrange moves them, and reads positions only committed next frame.
  const resetCanvas = useCallback(() => {
    sizesRef.current = {};
    setSizes({});
    const frames = framesRef.current;
    for (const f of frames) if (f.parentFrameId) arrangeFrame(f.id, "grid");
    requestAnimationFrame(() => {
      for (const f of framesRef.current) if (!f.parentFrameId) arrangeFrame(f.id, "grid");
      requestAnimationFrame(() => requestAnimationFrame(() =>
        setFocusModeReq({ id: null, n: ++focusModeNonceRef.current })));
    });
  }, [arrangeFrame, framesRef, sizesRef, setSizes]);

  // ── the shared tile surfaces (bodies) — rendered ONCE by the TileHost ─────
  // A title change rebuilds only that tile's body: the host reports one only when what the
  // agent says it is doing changes. buildSurfaces carries the per-workspace reuse cache (keyed on persistKey);
  // the memo below must list EVERY input that can change a body — the builder
  // diffs per tile and reuses the rest (callbacks included, so a changed
  // handler can never leave a stale closure behind).
  const tilesVersion = useTilesVersion();
  // A plugin registering changes what a tile shows without changing the tile: start the cache afresh.
  const buildSurfaces = useMemo(() => createTileSurfaceBuilder(), [persistKey, tilesVersion]);
  const surfaces = useMemo(() => buildSurfaces({
    repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, editorTabs, browserOpenReqs, tileNames, agentTitles,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, renameTile, sleepTile, wakeTile,
    onTogglePin: togglePin,
  }), [
    buildSurfaces, repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, editorTabs, browserOpenReqs, tileNames, agentTitles,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, renameTile, sleepTile, wakeTile, togglePin,
  ]);

  // What the person here has selected, for the others in the workspace to see, whichever view
  // shows it (M1).
  const presenceSelection = useMemo(
    () => [selectedTileId, selectedFrameId, board.selectedId].filter((id): id is string => !!id),
    [selectedTileId, selectedFrameId, board.selectedId],
  );

  // ── what the active view receives ─────────────────────────────────────────
  const links = useMemo(() => ({ pipes, spawnLinks }), [pipes, spawnLinks]);
  const model: WorkspaceViewModel = useMemo(() => ({
    repoPath, root, cwd, layoutKey: persistKey,
    tiles, frames, frameOf, tileNames, agentTitles, selectedTileId, selectedFrameId,
    layerTiles, layerFrames, frameActions, sleepActions, links,
  }), [repoPath, root, cwd, persistKey, tiles, frames, frameOf, tileNames, agentTitles, selectedTileId, selectedFrameId, layerTiles, layerFrames, frameActions, sleepActions, links]);
  const commands: WorkspaceCommands = useMemo(() => ({
    selectTile: setSelectedTileId,
    selectFrame: setSelectedFrameId,
    focusTile,
    closeTile,
    spawnTile: (kind, frameId, opts) => spawnTile(kind, frameId, opts ?? {}),
    spawnVis,
    spawnClaude: () => spawnDefaultAgent(), // protocol name (1.0); it starts the DEFAULT agent
    addFrame,
    spawnAgent: (agentId, frameId, opts) => {
      const def = agentId ? catalogAgentById(agentId) : agentToStart();
      if (!def) return false;
      const id = spawnTile(AGENT_TILE_KIND, frameId, { agent: { id: def.id, cmd: def.bin, label: def.label }, ...(opts?.prompt ? { work: opts.prompt } : {}), ...(opts?.resume ? { resume: opts.resume } : {}) });
      if (id && opts?.name) renameTile(id, opts.name);
      return !!id;
    },
    renameTile,
    openFolder: (frameId) => void bindWorkspace(frameId),
    wakeAgent: (tileId) => void sleepActions.wake(tileId),
    sleepAgent: (tileId) => void sleepActions.sleep(tileId),
    // The toolbar's own menus, for a view that draws its own toolbar.
    openHostMenu: (menu, at) => {
      if (menu === "views") openViewMenu(at);
      else if (menu === "add") openAdd();
      else if (menu === "appearance") openAppearanceSettings();
      else window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: {} }));
    },
    // Module-level bus functions: stable identities, so status never enters the
    // memo deps — a status transition re-renders nothing here.
    subscribeTileStatus: (tileId, cb) => subscribeTileStatus(tileId, (e) => cb(e.status, e)),
    tileStatus: statusOf,
  }), [setSelectedTileId, setSelectedFrameId, focusTile, closeTile, spawnTile, spawnVis, spawnDefaultAgent, addFrame, renameTile, bindWorkspace, sleepActions]);


  // The canvas plugin's private runtime access (milestone-1 seam).
  const canvasRuntime: CanvasRuntime = useMemo(() => ({
    positions, sizes, currentViewportRef, setViewport: saveCamera,
    onNodeResizeCommit, handleNodeDragStop, resetCanvas,
    focusReq, focusModeReq, setFocusModeReq, focusModeNonceRef, selectedTileIdRef, selectedFrameIdRef,
    selectedTileIdsRef, markSeen, toasts, dismissToast,
    frameTiles, updateFrameTitle, bringFrameToFront,
    pins, togglePin, onPinChange, board, canvasPointRef,
    agentSel, setAgentSel, spawnAgent, spawnBrowser,
    updateAvailable, updateStaged, onUpgrade: () => onUpgrade?.(), onRestart: () => onRestart?.(), upgrading,
  }), [
    positions, sizes, saveCamera, onNodeResizeCommit, handleNodeDragStop, resetCanvas, focusReq, focusModeReq,
    selectedTileIdRef, selectedFrameIdRef, selectedTileIdsRef, markSeen, toasts, dismissToast, frameTiles,
    updateFrameTitle, bringFrameToFront,
    pins, togglePin, onPinChange, board, agentSel, spawnAgent, spawnBrowser, updateAvailable, updateStaged, onUpgrade, onRestart, upgrading,
  ]);

  const viewProps = useMemo(() => ({ model, commands }), [model, commands]);

  return (
    <CanvasRuntimeContext.Provider value={canvasRuntime}>
    <div className="relative h-full w-full flex flex-col" data-active-view={activeViewId ?? ""}>
      {/* Live wallpaper — fixed full-window layer behind ALL app content (z-index
          -1), so it shows through every view AND the panels beside it. */}
      {chrome.wallpaper && <Wallpaper />}
      {/* Custom OVERLAY media — user's transparent foreground plane OVER the
          tiles. Fixed full-window + pointer-events:none. Same policy as the
          wallpaper: never over a view that paints its own scene. */}
      {chrome.wallpaper && <CanvasOverlay />}
      {/* The active view plugin, behind its crash boundary. Bodies are NOT in
          this subtree (TileHost below), so a view crash or switch never touches
          a live session. */}
      <ViewHost
        viewId={activeViewId}
        attempt={viewAttempt}
        props={viewProps}
        onError={onViewError}
        failed={viewFailure && viewFailure.id === activeViewId ? viewFailure.error : null}
        onSwitch={switchView}
        onRetry={() => { setViewFailure(null); setViewAttempt((n) => n + 1); }}
      />
      {repoPath && <SayHere repo={repoPath} selection={presenceSelection} />}
      <Suspense fallback={null}>
        <BoardContext.Provider value={board}><WidgetLayer repo={persistKey} board={board} packages={widgetPackages} edge={chrome.widgets} /></BoardContext.Provider>
      </Suspense>
      {/* Reset transient toolbar expansion on view/placement changes without
          touching live tile bodies. Settings lives above this in App. */}
      <HostChrome
        key={`${activeViewId}:${chrome.island}`}
        chrome={chrome}
        toolbar={activeViewId ? settings.views.toolbars[activeViewId] : undefined}
        repoPath={repoPath}
        agentSel={agentSel}
        onAgentChange={setAgentSel}
        onSpawnAgent={spawnAgent}
        onFrame={addFrame}
        onBrowser={spawnBrowser}
        onBoard={addBoard}
        onTile={(kind, frameId) => (frameId ? frameOpen(frameId, kind) : spawnInto(kind))}
        boardItems={activeViewId === "canvas"}
        updateAvailable={updateAvailable}
        updateStaged={updateStaged}
        onUpgrade={() => onUpgrade?.()}
        onRestart={() => onRestart?.()}
        upgrading={upgrading}
      />
      {/* Shared-layer selection: a body's native pointerdown selects its tile
          (React synthetic events from a portaled body never reach a view's own
          handlers — see tile-host.tsx). */}
      <WorkspacePropsContext.Provider value={viewProps}>
        <ToolPlugins />
        <Suspense fallback={null}><WidgetLinks /></Suspense>
        <TileHost surfaces={surfaces} selectedTileId={selectedTileId} onSurfacePointerDown={setSelectedTileId} />
      </WorkspacePropsContext.Provider>

      <DeleteFrameDialog ask={frameDeleteAsk} onChoose={onFrameDeleteChoice} />
      {sleepAgents.dialog}
      {/* Where a new tile runs, when 2+ workspaces are open: asked here, so every view spawns alike. */}
      {spawnPick && (
        <PickerDialog
          title={`Start ${spawnPick.agent?.label ?? tileKind(spawnPick.kind).title ?? "it"} in`}
          rows={frames
            .filter((f) => !f.parentFrameId)
            .flatMap((p) => [p, ...frames.filter((c) => c.parentFrameId === p.id)])
            .map((f) => ({
              id: f.id, label: f.title, indent: !!f.parentFrameId,
              icon: <span aria-hidden className="size-2 rounded-full" style={{ background: f.color }} />,
              detail: f.id === selectedFrameId ? "selected" : f.parentFrameId ? "worktree" : undefined,
            }))}
          onPick={(id) => spawnTile(spawnPick.kind, id, { mode: spawnPick.mode, work: spawnPick.work, url: spawnPick.url, agent: spawnPick.agent })}
          onClose={() => setSpawnPick(null)}
        />
      )}
      {machinesReq && (
        <Suspense fallback={null}>
          <MachinesHub
            request={machinesReq}
            onClose={() => setMachinesReq(null)}
            usageOf={machineUsage}
            onEndTerminals={endTerminalsOn}
            // Opened from a machine rather than a frame: the folder you chose is the
            // point, so give it a frame instead of dropping it.
            onPick={(frameId, uri) => bindRemote(frameId ?? addFrame(), uri)}
          />
        </Suspense>
      )}
      {agentPick && (
        <PickerDialog
          title="Send to agent"
          description={agentPick.text}
          rows={frames.flatMap((f) => tiles
            .filter((t) => t.kind === AGENT_TILE_KIND && frameOf[t.id] === f.id)
            .map((t) => ({ id: t.id, label: tileName(tileNames, agentTitles, t), group: f.title, icon: <AgentIcon id={agentForCmd(t.cmd)?.id} size={13} /> })))}
          extra={readyAgents.length
            ? readyAgents.map((a) => ({ id: `${NEW_AGENT_ROW}${a.id}`, label: `New ${a.label}`, icon: <Plus size={13} /> }))
            : [{ id: NEW_AGENT_ROW, label: "New agent", icon: <Plus size={13} /> }]}
          onPick={(id) => deliverToAgent(agentPick.text, id)}
          onClose={() => setAgentPick(null)}
        />
      )}
      {/* Git commit/sync modal — opened per-frame via hivemind:frame-git, in
          every view. */}
      <GitCommitModal
        repoPath={gitModalRepo}
        open={gitModalRepo !== null}
        onOpenChange={(o) => { if (!o) setGitModalRepo(null); }}
      />
    </div>
    </CanvasRuntimeContext.Provider>
  );
}
