/**
 * useCanvasShortcuts — wires the canvas keyboard shortcuts + the CommandPalette/
 * menu custom-event listeners (spawn-claude, canvas-toggle, add-frame,
 * frame-open, focus-tile). Lifted from Canvas.tsx; takes the spawn/frame actions
 * + selection refs as context. Number-row tool hotkeys, ⌘\/⌘B/T/D, "." focus,
 * Escape fit-all, F2 rename — with the same text-field guards.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { inEditable } from "./dom-focus";
import type { TileInstance } from "./canvas-persistence";

type FocusModeReq = { id: string | null; n: number } | null;

export interface CanvasShortcutsCtx {
  repoPath: string | null;
  spawnClaude: (mode?: string, work?: string) => void;
  /** Spawn the tool island's currently-selected agent (claude/codex/opencode). */
  spawnSelectedAgent: () => void;
  spawnVis: (which: "tree" | "shell" | "diff" | "issues") => void;
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
}

export function useCanvasShortcuts(ctx: CanvasShortcutsCtx) {
  const {
    repoPath, spawnClaude, spawnSelectedAgent, spawnVis, spawnBrowser, addFrame, frameOpen, focusTile, closeTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef,
  } = ctx;

  useEffect(() => {
    const onSpawn = (e: Event) => {
      const d = (e as CustomEvent).detail;
      const obj = d && typeof d === "object" ? (d as { mode?: string; work?: string }) : undefined;
      spawnClaude(obj?.mode, obj?.work);
    };
    const onToggle = (e: Event) => {
      const which = (e as CustomEvent<"tree" | "shell" | "diff" | "issues">).detail;
      if (which === "tree" || which === "shell" || which === "diff" || which === "issues") {
        spawnVis(which);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      // ── modifier shortcuts ── VS Code's app-wide keys (new terminal, explorer, diff, agent,
      // Layers, tile N, next tile, settings) come from main, before xterm sees them — see the
      // "menu:shortcut" handler below. These are the ones that are the canvas's only when you
      // are NOT typing: inside a tile Ctrl +/−/0 size its font, and the shell's Ctrl+W deletes
      // a word — closing an agent by accident is not a shortcut.
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "e" || e.key === "E") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")); }
        else if (inEditable(e.target)) { /* the tile's */ }
        else if (e.key === "0") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "100" })); }
        else if (e.key === "=" || e.key === "+") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "in" })); }
        else if (e.key === "-") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:zoom", { detail: "out" })); }
        // Open folder / Open recent switch the whole project, as in VS Code. Canvas-only: inside a
        // terminal Ctrl+R is the shell's history search and Ctrl+O is its own.
        else if (e.key === "o" || e.key === "O") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:open-folder")); }
        else if (e.key === "r" || e.key === "R") { e.preventDefault(); window.dispatchEvent(new CustomEvent("hivemind:open-recent")); }
        else if (e.key === "w" || e.key === "W") {
          const id = selectedTileIdRef.current;
          if (id) { e.preventDefault(); closeTile(id); }
        }
        return;
      }
      // Focus-mode hotkeys (".", Escape) fire ONLY when no editable element is
      // focused. Previously they used !inTextField, which excluded xterm's helper
      // textarea — so "." and Escape typed into a terminal were stolen by the
      // canvas (Escape → fit-all zoom, "." → zoom-to-tile) instead of reaching the
      // agent. Escape especially is load-bearing inside claude/droid's TUI. Now
      // any focused terminal/editor gets them; use ". "/Escape on the canvas by
      // clicking the background first (no tile selected).
      if (!inEditable(e.target)) {
        if (e.key === ".") {
          const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
          if (id) { e.preventDefault(); setFocusModeReq({ id, n: ++focusModeNonceRef.current }); }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setFocusModeReq({ id: null, n: ++focusModeNonceRef.current });
          return;
        }
      }
      // ── single-key tool hotkeys (number row only) — when NOT typing ──
      // Bare letter aliases were removed (a stray `a` spawned a claude session in
      // a dev tool). Numbers match the ToolIsland hint badges 1-6.
      if (inEditable(e.target)) return;
      switch (e.key) {
        case "1": e.preventDefault(); spawnVis("shell"); break;
        case "2": e.preventDefault(); spawnSelectedAgent(); break;
        case "3": if (repoPath) { e.preventDefault(); spawnVis("tree"); } break;
        case "4": if (repoPath) { e.preventDefault(); spawnVis("diff"); } break;
        case "5": if (repoPath) { e.preventDefault(); spawnVis("issues"); } break;
        case "6": e.preventDefault(); addFrame(); break;
        case "7": e.preventDefault(); spawnBrowser(); break;
        case "F2": {
          const sel = selectedFrameIdRef.current;
          if (!sel) return;
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("hivemind:frame-rename", { detail: sel }));
          break;
        }
        default: break;
      }
    };
    const onAddFrame = () => addFrame();
    const onFrameOpen = (e: Event) => {
      const d = (e as CustomEvent<{ frameId: string; kind: string }>).detail;
      if (d?.frameId && d?.kind) frameOpen(d.frameId, d.kind);
    };
    // Ctrl/Cmd+. (forwarded from main → App) focuses the selected tile. Same
    // action as the plain "." binding above, but that key is eaten by xterm when
    // a terminal has focus, so the modifier combo arrives here as a CustomEvent.
    const onFocusSelected = () => {
      const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
      if (id) setFocusModeReq({ id, n: ++focusModeNonceRef.current });
    };
    // VS Code keys main intercepted (they work from inside a terminal). Tiles are numbered in
    // the order they were opened, which is also the order Ctrl+Tab walks.
    const onShortcut = (e: Event) => {
      const action = (e as CustomEvent<string>).detail;
      const tiles = tilesRef.current;
      const select = (id: string | undefined) => { if (id) { setSelectedTileId(id); focusTile(id); } };
      const step = (by: number) => {
        if (!tiles.length) return;
        const i = tiles.findIndex((t) => t.id === selectedTileIdRef.current);
        select(tiles[((i < 0 ? (by > 0 ? -1 : 0) : i) + by + tiles.length) % tiles.length]?.id);
      };
      if (action === "new-terminal") spawnVis("shell");
      else if (action === "explorer") { if (repoPath) spawnVis("tree"); }
      else if (action === "diff") { if (repoPath) spawnVis("diff"); }
      else if (action === "agent") spawnSelectedAgent();
      else if (action === "new-frame") addFrame();
      else if (action === "settings") window.dispatchEvent(new CustomEvent("hivemind:open-settings", { detail: {} }));
      else if (action === "next-tile") step(1);
      else if (action === "prev-tile") step(-1);
      else if (action.startsWith("tile:")) select(tiles[Number(action.slice(5)) - 1]?.id);
    };
    // A native agent notification was clicked → select + fly to that tile.
    const onFocusTile = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id || !tilesRef.current.some((t) => t.id === id)) return;
      setSelectedTileId(id);
      focusTile(id);
    };
    window.addEventListener("hivemind:spawn-claude", onSpawn);
    window.addEventListener("hivemind:canvas-toggle", onToggle as EventListener);
    window.addEventListener("hivemind:add-frame", onAddFrame);
    window.addEventListener("hivemind:frame-open", onFrameOpen as EventListener);
    window.addEventListener("hivemind:focus-tile", onFocusTile as EventListener);
    window.addEventListener("hivemind:focus-selected", onFocusSelected);
    window.addEventListener("hivemind:shortcut", onShortcut);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hivemind:spawn-claude", onSpawn);
      window.removeEventListener("hivemind:canvas-toggle", onToggle as EventListener);
      window.removeEventListener("hivemind:add-frame", onAddFrame);
      window.removeEventListener("hivemind:frame-open", onFrameOpen as EventListener);
      window.removeEventListener("hivemind:shortcut", onShortcut);
      window.removeEventListener("hivemind:focus-tile", onFocusTile as EventListener);
      window.removeEventListener("hivemind:focus-selected", onFocusSelected);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);
}
