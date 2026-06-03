/**
 * useCanvasShortcuts — wires the canvas keyboard shortcuts + the CommandPalette/
 * menu custom-event listeners (spawn-claude, canvas-toggle, add-frame,
 * frame-open, focus-tile). Lifted from Canvas.tsx; takes the spawn/frame actions
 * + selection refs as context. Number-row tool hotkeys, ⌘\/⌘B/T/D, "." focus,
 * Escape fit-all, F2 rename — with the same text-field guards.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { inEditable, inTextField } from "./dom-focus";
import type { TileInstance } from "./canvas-persistence";

type FocusModeReq = { id: string | null; n: number } | null;

export interface CanvasShortcutsCtx {
  repoPath: string | null;
  spawnClaude: (mode?: string, work?: string) => void;
  spawnVis: (which: "tree" | "shell" | "diff" | "issues") => void;
  addFrame: () => void;
  frameOpen: (frameId: string, kind: string) => void;
  focusTile: (id: string) => void;
  setSelectedTileId: Dispatch<SetStateAction<string | null>>;
  setFocusModeReq: Dispatch<SetStateAction<FocusModeReq>>;
  selectedTileIdRef: MutableRefObject<string | null>;
  selectedFrameIdRef: MutableRefObject<string | null>;
  focusModeNonceRef: MutableRefObject<number>;
  tilesRef: MutableRefObject<TileInstance[]>;
}

export function useCanvasShortcuts(ctx: CanvasShortcutsCtx) {
  const {
    repoPath, spawnClaude, spawnVis, addFrame, frameOpen, focusTile,
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
      // ── modifier shortcuts (kept for muscle memory) ──
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "\\") { e.preventDefault(); spawnClaude(); }
        else if ((e.key === "b" || e.key === "B") && repoPath) { e.preventDefault(); spawnVis("tree"); }
        else if (e.key === "t" || e.key === "T") { e.preventDefault(); spawnVis("shell"); }
        else if ((e.key === "d" || e.key === "D") && repoPath) { e.preventDefault(); spawnVis("diff"); }
        return;
      }
      // Focus-mode hotkeys fire even when typing in a TILE (xterm/CodeMirror are
      // "editable" but you navigate the canvas from them) — but NOT in a real
      // text field (tile-rename input, palette, form) where "." and Escape type.
      if (!inTextField(e.target)) {
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
        case "2": e.preventDefault(); spawnClaude(); break;
        case "3": if (repoPath) { e.preventDefault(); spawnVis("tree"); } break;
        case "4": if (repoPath) { e.preventDefault(); spawnVis("diff"); } break;
        case "5": if (repoPath) { e.preventDefault(); spawnVis("issues"); } break;
        case "6": e.preventDefault(); addFrame(); break;
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
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hivemind:spawn-claude", onSpawn);
      window.removeEventListener("hivemind:canvas-toggle", onToggle as EventListener);
      window.removeEventListener("hivemind:add-frame", onAddFrame);
      window.removeEventListener("hivemind:frame-open", onFrameOpen as EventListener);
      window.removeEventListener("hivemind:focus-tile", onFocusTile as EventListener);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);
}
