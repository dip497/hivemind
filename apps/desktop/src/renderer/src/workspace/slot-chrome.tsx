/**
 * slot-chrome — the thin bar the HOST draws on a tile surface it placed for a
 * view that is not an arrangement (the World's dock pane, a community view's
 * hole-punched rect): the tile's name, a live status dot, "pop out" (select
 * the tile on the canvas, 1:1, and switch there) and "undock". The bar is the
 * host's, so it looks and behaves the same whichever view asked for the slot.
 *
 * Keyboard: **Shift+Esc undocks even while the terminal has the keyboard**
 * (plain Esc belongs to a focused TUI — claude interrupts on it). One capture
 * listener per mounted bar; the most recently mounted wins.
 */
import { useEffect, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import type { TileStatusKind } from "../agent-status-bus";
import { bucketTileStatus, type TileStatusBucket } from "./tile-status-bucket";
import { setViewMode } from "./view-mode-store";
import type { WorkspaceCommands } from "./workspace-view";

const DOT: Record<TileStatusBucket, string> = {
  working: "bg-[var(--color-ok)]", idle: "bg-[var(--color-info)]", blocked: "bg-[var(--color-warn)]", exited: "bg-[var(--color-err)]", unknown: "bg-[var(--color-fg3)]",
};

export const SLOT_BAR_HEIGHT = 28;

export function SlotBar({ tileId, name, commands, onUndock, popOutView = "canvas" }: {
  tileId: string;
  name: string;
  commands: Pick<WorkspaceCommands, "subscribeTileStatus" | "focusTile" | "selectTile" | "tileStatus">;
  onUndock: () => void;
  /** The arranging view to pop the tile out into. */
  popOutView?: string;
}) {
  // Seed from the bus: `subscribeTileStatus` only replays a status that was
  // already emitted, so a tile the rail shows as idle would otherwise sit on
  // "unknown" forever. Same rule as LayersPanel: no entry on the bus = idle.
  const [status, setStatus] = useState<TileStatusKind | null>(() => commands.tileStatus(tileId));
  useEffect(() => commands.subscribeTileStatus(tileId, (s) => setStatus(s)), [tileId, commands]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !e.shiftKey) return;
      e.preventDefault(); e.stopPropagation();
      onUndock();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onUndock]);
  const popOut = () => {
    commands.selectTile(tileId);
    commands.focusTile(tileId, { exact: true });
    setViewMode(popOutView);
  };
  const bucket = status === null ? "idle" : bucketTileStatus(status);
  return (
    <div
      tabIndex={-1}
      className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg2)] px-2 text-[12px] text-[var(--color-fg)] outline-none select-none"
      style={{ height: SLOT_BAR_HEIGHT }}
      data-slot-bar={tileId}
    >
      <span className={`size-2 shrink-0 rounded-full ${DOT[bucket]}`} title={status ?? "idle"} data-slot-status={bucket} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <kbd className="font-mono text-[9.5px] text-[var(--color-fg3)]">⇧Esc</kbd>
      <button onClick={popOut} aria-label="Pop out to canvas" title="Pop out: show this tile on the canvas" className="grid size-6 place-items-center rounded hover:bg-[var(--color-bg3)]">
        <ArrowUpRight size={13} />
      </button>
      <button onClick={onUndock} aria-label="Undock" title="Undock (Shift+Esc)" className="grid size-6 place-items-center rounded hover:bg-[var(--color-bg3)]">
        <X size={13} />
      </button>
    </div>
  );
}
