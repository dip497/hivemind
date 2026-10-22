/**
 * useCanvasShortcuts — runs the keymap's canvas and app actions (shared/keymap.ts) and the
 * CommandPalette/menu events (spawn-agent, canvas-toggle, add-frame, frame-open, focus-tile).
 * The canvas's keys act only while nothing is typed into: in a terminal or a field they are theirs.
 */
import { panelOrder } from "./workspace/panel-order";
import { canSpawnKind } from "./tiles/api";
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { inEditable } from "./dom-focus";
import { IS_MAC, runShortcut } from "./shortcut";
import { actionsFor } from "../../shared/keymap";
import type { TileInstance } from "./canvas-persistence";
import type { Board } from "./board-objects/useBoard";
import type { BoardChoice } from "./board-objects/board-model";

type FocusModeReq = { id: string | null; n: number } | null;

export interface CanvasShortcutsCtx {
  repoPath: string | null;
  spawnDefaultAgent: (mode?: string, work?: string, agentId?: string) => void;
  /** Spawn the tool island's currently-selected agent (claude/codex/opencode). */
  spawnSelectedAgent: () => void;
  spawnVis: (which: string) => void;
  /** Spawn a Browser tile into the active/resolved frame. */
  spawnBrowser: () => void;
  addFrame: () => void;
  frameOpen: (frameId: string, kind: string) => void;
  focusTile: (id: string) => void;
  closeTile: (id: string) => void;
  setSelectedTileId: Dispatch<SetStateAction<string | null>>;
  setFocusModeReq: Dispatch<SetStateAction<FocusModeReq>>;
  selectedTileIdRef: MutableRefObject<string | null>;
  selectedFrameIdRef: MutableRefObject<string | null>;
  focusModeNonceRef: MutableRefObject<number>;
  tilesRef: MutableRefObject<TileInstance[]>;
  /** The board as last rendered: the handler is installed once, so it reads through this. */
  boardRef: MutableRefObject<Board>;
  addBoard: (kind: BoardChoice) => void;
  /** The board is the canvas's: its keys do nothing in another view. */
  onCanvas: () => boolean;
}

export function useCanvasShortcuts(ctx: CanvasShortcutsCtx) {
  const {
    repoPath, spawnDefaultAgent, spawnSelectedAgent, spawnVis, spawnBrowser, addFrame, frameOpen, focusTile, closeTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef, boardRef, addBoard, onCanvas,
  } = ctx;

  useEffect(() => {
    const onSpawn = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const obj = d && typeof d === "object" ? (d as { mode?: string; work?: string; agent?: string }) : undefined;
      spawnDefaultAgent(obj?.mode, obj?.work, obj?.agent);
    };
    // "tree" is the Code tile on its files; any other is a kind a plugin draws.
    const onToggle = (e: Event) => {
      const which = (e as CustomEvent<string>).detail;
      if (typeof which === "string" && (which === "tree" || canSpawnKind(which))) spawnVis(which);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || inEditable(e.target)) return;
      // Writing in a board object: its field may not have focus yet (a node just added is
      // shown once measured), and a key typed meanwhile is text, never a tool.
      if (boardRef.current.editingId) return;
      for (const action of actionsFor(e, "canvas", IS_MAC)) {
        if (!runShortcut(action)) continue;
        e.preventDefault();
        return;
      }
    };
    const onAddFrame = () => addFrame();
    const onFrameOpen = (e: Event) => {
      const d = (e as CustomEvent<{ frameId: string; kind: string }>).detail;
      if (d?.frameId && d?.kind) frameOpen(d.frameId, d.kind);
    };
    const focusSelected = () => {
      const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
      if (!id) return false;
      setFocusModeReq({ id, n: ++focusModeNonceRef.current });
    };
    const send = (name: string, detail?: unknown) => { window.dispatchEvent(new CustomEvent(name, { detail })); };
    /** Each action of the keymap the canvas owns. False: nothing to do, the key goes on. Tiles are
     *  numbered in the order they were opened, which is also the order Ctrl+Tab walks. */
    const run = (action: string): boolean | void => {
      const tiles = tilesRef.current;
      const board = boardRef.current;
      const select = (id: string | undefined) => { if (id) { setSelectedTileId(id); focusTile(id); } };
      const step = (by: number) => {
        if (!tiles.length) return;
        const i = tiles.findIndex((t) => t.id === selectedTileIdRef.current);
        select(tiles[((i < 0 ? (by > 0 ? -1 : 0) : i) + by + tiles.length) % tiles.length]?.id);
      };
      if (action.startsWith("tile:")) {
        // As the Layers panel lists them, when it is shown; else in the order opened.
        const n = Number(action.slice(5)) - 1;
        const listed = panelOrder().filter((id) => tiles.some((t) => t.id === id));
        return select(listed.length ? listed[n] : tiles[n]?.id);
      }
      switch (action) {
        case "new-terminal": return spawnVis("shell");
        case "explorer": if (!repoPath) return false; return spawnVis("tree");
        case "agent": return spawnSelectedAgent();
        case "new-frame": return addFrame();
        case "new-browser": return spawnBrowser();
        case "settings": return send("hivemind:open-settings", {});
        case "next-tile": return step(1);
        case "prev-tile": return step(-1);
        case "focus-selected": return focusSelected();
        case "toggle-layers": return send("hivemind:toggle-layers");
        case "toggle-view-mode": return send("hivemind:toggle-view-mode");
        case "zoom-reset": return send("hivemind:zoom", "100");
        case "zoom-in": return send("hivemind:zoom", "in");
        case "zoom-out": return send("hivemind:zoom", "out");
        case "open-folder": return send("hivemind:open-folder");
        case "open-recent": return send("hivemind:open-recent");
        case "close-tile": {
          const id = selectedTileIdRef.current;
          if (!id) return false;
          return closeTile(id);
        }
        // The board's history: undo and redo take back board edits only (the store's rule).
        case "undo": if (!onCanvas()) return false; return board.undo();
        case "redo": if (!onCanvas()) return false; return board.redo();
        case "duplicate": if (!onCanvas() || !board.selectedId) return false; return board.duplicate(board.selectedId);
        case "remove-selected": if (!onCanvas() || !board.selectedId) return false; return board.remove(board.selectedId);
        case "stop-arrow": if (board.arrowFrom === undefined) return false; return board.cancelArrow();
        case "deselect": if (!board.selectedId) return false; return board.select(null);
        case "fit-all": return setFocusModeReq({ id: null, n: ++focusModeNonceRef.current });
        case "rename-frame": {
          const sel = selectedFrameIdRef.current;
          if (!sel) return false;
          return send("hivemind:frame-rename", sel);
        }
        default: return false;
      }
    };
    const onShortcut = (e: Event) => {
      if (run((e as CustomEvent<string>).detail) !== false) e.preventDefault();
    };
    // A native agent notification was clicked → select + fly to that tile.
    const onFocusTile = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id || !tilesRef.current.some((t) => t.id === id)) return;
      setSelectedTileId(id);
      focusTile(id);
    };
    window.addEventListener("hivemind:spawn-agent", onSpawn);
    window.addEventListener("hivemind:canvas-toggle", onToggle as EventListener);
    window.addEventListener("hivemind:add-frame", onAddFrame);
    window.addEventListener("hivemind:frame-open", onFrameOpen as EventListener);
    window.addEventListener("hivemind:focus-tile", onFocusTile as EventListener);
    window.addEventListener("hivemind:shortcut", onShortcut);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hivemind:spawn-agent", onSpawn);
      window.removeEventListener("hivemind:canvas-toggle", onToggle as EventListener);
      window.removeEventListener("hivemind:add-frame", onAddFrame);
      window.removeEventListener("hivemind:frame-open", onFrameOpen as EventListener);
      window.removeEventListener("hivemind:shortcut", onShortcut);
      window.removeEventListener("hivemind:focus-tile", onFocusTile as EventListener);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);
}
