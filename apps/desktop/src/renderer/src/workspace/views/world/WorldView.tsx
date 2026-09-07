/**
 * WorldView — the built-in Three.js view (design doc phase 3). Proves the view
 * contract carries a world, not just a layout: islands for frames, blocks for
 * tiles, colour from the per-tile status subscription, and — the point of the
 * demo — click a block and its LIVE surface docks in a DOM panel over the scene
 * (a real `<TileSlot>`, never a texture; the terminal keeps its keyboard).
 *
 * Rules this file keeps (see world-scene.ts for the render-on-demand contract):
 *  • the scene is built once per mount and reconciled from the model (frames,
 *    tiles, membership, names) — `agentTitles` churn is NOT a dependency;
 *  • status arrives per tile through `commands.subscribeTileStatus`, never
 *    through the model; one subscription per block, torn down with it;
 *  • one `<TileSlot>` at most (the docked tile); every other tile is parked —
 *    the hidden-terminal rule (they do nothing);
 *  • the layout blob (camera + island placements) persists through
 *    `useViewLayout("world", v1)`, debounced.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { TileSlot } from "../../tile-host";
import { useViewLayout } from "../../view-layout-store";
import type { WorkspaceViewProps } from "../../workspace-view";
import type { TileStatusKind } from "../../../agent-status-bus";
import { WORLD_LAYOUT, placeIslands, type WorldCamera } from "./world-layout";
import { WorldScene, type WorldStatus } from "./world-scene";

// Chunk-load marker (test seam): set when THIS lazy chunk is evaluated, so the
// e2e suite can prove three.js + the scene are not part of the default path
// (module scripts loaded from file:// leave no resource-timing entry to check).
(window as Window & { __hivemindWorldLoaded?: true }).__hivemindWorldLoaded = true;

/** Bus status → the scene's colour buckets. */
export function toWorldStatus(s: TileStatusKind | null): WorldStatus {
  switch (s) {
    case "working": return "working";
    case "idle": return "idle";
    case "exited": return "exited";
    case "blocked": case "permission": case "question": case "plan_review": case "awaiting_approval": return "blocked";
    default: return "unknown";
  }
}

export default function WorldView({ model, commands }: WorkspaceViewProps) {
  const { frames, tiles, frameOf, layerTiles, selectedTileId, layoutKey } = model;
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const [layout, setLayout] = useViewLayout(WORLD_LAYOUT, layoutKey);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [hover, setHover] = useState<{ tileId: string | null; frameId: string | null; x: number; y: number } | null>(null);
  const [docked, setDocked] = useState<string | null>(null);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // Names: the display name the Layers rail would show (renames + agent titles
  // resolved by the runtime). Read through a ref so the scene reconciles from
  // structural changes only; a title tick updates labels on the next hover.
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of layerTiles) m.set(t.id, t.name);
    return m;
  }, [layerTiles]);
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  // ── scene lifecycle: build once per mount, dispose on unmount ──────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new WorldScene(host, {
      onHover: (tileId, frameId, at) => setHover(at ? { tileId, frameId, x: at.x, y: at.y } : null),
      onClickTile: (tileId) => { setDocked(tileId); commandsRef.current.selectTile(tileId); },
      onClickFrame: (frameId) => { scene.flyToFrame(frameId); commandsRef.current.selectFrame(frameId); },
      onCameraSettled: (camera: WorldCamera) => setLayout((l) => ({ ...l, camera })),
    }, layoutRef.current.camera);
    sceneRef.current = scene;
    // Test seam: the e2e suite projects a tile to click it and reads the frame
    // counter to prove render-on-demand. Same spirit as the `__probe` tags.
    const outer = host.parentElement as (HTMLElement & { __world?: WorldScene }) | null;
    if (outer) outer.__world = scene;
    return () => { scene.dispose(); sceneRef.current = null; if (outer) delete outer.__world; };
    // The scene lives for the mount; layout/camera are read once at creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── content reconcile: frames / tiles / membership / placements ────────────
  const islands = useMemo(() => placeIslands(frames.map((f) => f.id), layout.islands), [frames, layout.islands]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setContent(
      frames.map((f) => ({ id: f.id, title: f.title, color: f.color, x: islands[f.id]!.x, z: islands[f.id]!.z })),
      tiles.map((t) => ({ id: t.id, frameId: frameOf[t.id] ?? null, name: nameRef.current.get(t.id) ?? t.label })),
    );
  }, [frames, tiles, frameOf, islands]);

  // ── status: one subscription per tile, colouring one block each ────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const unsubs = tiles.map((t) =>
      commands.subscribeTileStatus(t.id, (status) => scene.setTileStatus(t.id, toWorldStatus(status))),
    );
    return () => { for (const u of unsubs) u(); };
  }, [tiles, commands]);

  // ── docking ────────────────────────────────────────────────────────────────
  const dockedValid = docked !== null && tiles.some((t) => t.id === docked);
  useEffect(() => { sceneRef.current?.setDocked(dockedValid ? docked : null); }, [docked, dockedValid]);
  // A runtime selection that CHANGES while the world is up (rail click, an
  // agent's tile.focus, a toast) lands you in that tile. The selection you
  // arrive with is left alone: entering the world shows the map, not a dock.
  const firstSel = useRef(true);
  useEffect(() => {
    if (firstSel.current) { firstSel.current = false; return; }
    if (selectedTileId && selectedTileId !== docked && tiles.some((t) => t.id === selectedTileId)) setDocked(selectedTileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTileId]);
  const undock = useCallback(() => { setDocked(null); commandsRef.current.selectTile(null); }, []);
  // Esc undocks — unless the docked tile's body has the keyboard: Esc means
  // something to a TUI (claude interrupts on it), so a focused terminal keeps
  // its Esc and the panel's × (or clicking the panel header first) undocks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !docked) return;
      const inBody = !!document.activeElement?.closest("[data-world-dock] .hm-tile-surface");
      if (inBody) return;
      e.preventDefault();
      undock();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [docked, undock]);

  // Test seam: `hivemind:test-crash-view` {view:"world"} makes the next render
  // throw, so the e2e suite can prove the ViewHost falls back to the canvas
  // with every session intact. Inert in production (nobody dispatches it).
  const [crash, setCrash] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<{ view?: string }>).detail?.view === "world") setCrash(true); };
    window.addEventListener("hivemind:test-crash-view", on);
    return () => window.removeEventListener("hivemind:test-crash-view", on);
  }, []);
  if (crash) throw new Error("world view crashed (test)");

  const hoverName = hover?.tileId ? nameOf.get(hover.tileId) : hover?.frameId ? frames.find((f) => f.id === hover.frameId)?.title : null;
  const dockedName = dockedValid ? nameOf.get(docked!) ?? docked : null;

  return (
    <div className="relative flex-1 min-h-0 select-none" data-world-view>
      {/* The WebGL canvas mounts here (world-scene.ts). */}
      <div ref={hostRef} className="absolute inset-0" />
      {/* Hover label — DOM over the canvas. */}
      {hover && hoverName && (
        <div
          className="pointer-events-none absolute z-10 rounded-md bg-[var(--color-bg2)]/90 px-2 py-1 text-[11px] text-[var(--color-fg)] shadow"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
          data-world-hover
        >
          {hoverName}
        </div>
      )}
      {/* Docked tile: its live surface in a panel over the scene. Only ONE slot
          exists at a time; undocked tiles stay parked. */}
      {dockedValid && (
        <div
          className="absolute right-4 top-4 bottom-4 z-20 flex w-[56%] min-w-[420px] flex-col overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] shadow-2xl"
          data-world-dock={docked}
          role="dialog"
          aria-label={`Docked: ${dockedName}`}
        >
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg2)] px-3 text-[12px] text-[var(--color-fg)]">
            <span className="truncate">{dockedName}</span>
            <kbd className="ml-auto font-mono text-[9.5px] text-[var(--color-fg3)]">Esc</kbd>
            <button onClick={undock} aria-label="Undock" className="grid h-6 w-6 place-items-center rounded hover:bg-[var(--color-bg3)]">
              <X size={13} />
            </button>
          </div>
          <div className="relative flex-1 min-h-0">
            <TileSlot tileId={docked!} />
          </div>
        </div>
      )}
      {frames.length === 0 && tiles.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-[var(--color-fg3)]">
          No frames yet — add one to see it here.
        </div>
      )}
    </div>
  );
}
