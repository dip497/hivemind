/**
 * slot-chrome — the thin bar the HOST draws on a tile surface it placed for a
 * view that is not an arrangement (the World's dock pane, a community view's
 * hole-punched rect): the tile's name, a live status mark, Sleep for an agent
 * that is awake, "pop out" (select the tile on the canvas, 1:1, and switch
 * there) and "undock". The bar is the host's, so it looks and behaves the same
 * whichever view asked for the slot. It is the only bar there: the tile's own
 * title bar, with the × that ends it, is hidden in a slot (styles.css), so
 * what a person needs from that bar while the tile is docked is on this one.
 *
 * Keyboard: **Shift+Esc undocks even while the terminal has the keyboard**
 * (plain Esc belongs to a focused TUI — claude interrupts on it). One capture
 * listener per mounted bar; the most recently mounted wins.
 */
import { actionKey, onShortcut } from "../shortcut";
import { useEffect, useState } from "react";
import { ArrowUpRight, Moon, X } from "../components/icons";
import { Button } from "../components/ui/button";
import { setViewMode } from "./view-mode-store";
import type { WorkspaceCommands } from "./workspace-view";
import { exitFailed, LOOKS, StatusGlyph, statusLook, type StatusLook } from "./status-look";

export const SLOT_BAR_HEIGHT = 28;

export function SlotBar({ tileId, name, commands, onUndock, onSleep, popOutView = "canvas" }: {
  tileId: string;
  name: string;
  commands: Pick<WorkspaceCommands, "subscribeTileStatus" | "focusTile" | "selectTile" | "tileStatus">;
  onUndock: () => void;
  /** Put its agent to sleep; absent for a tile that cannot sleep (a shell) or already does. */
  onSleep?: () => void;
  /** The arranging view to pop the tile out into. */
  popOutView?: string;
}) {
  // Seed from the bus: `subscribeTileStatus` only replays a status that was
  // already emitted, so a tile the rail shows as idle would otherwise sit on
  // "unknown" forever. Same rule as LayersPanel: no entry on the bus = idle.
  const [look, setLook] = useState<StatusLook>(() => statusLook(commands.tileStatus(tileId)));
  useEffect(() => commands.subscribeTileStatus(tileId, (s, e) => setLook(statusLook(s, { failed: exitFailed(e) }))), [tileId, commands]);
  useEffect(() => onShortcut("undock", onUndock), [onUndock]);
  const popOut = () => {
    commands.selectTile(tileId);
    commands.focusTile(tileId, { exact: true });
    setViewMode(popOutView);
  };
  return (
    <div
      tabIndex={-1}
      className="flex shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-bg2)] px-2 text-label text-[var(--color-fg)] outline-none select-none"
      style={{ height: SLOT_BAR_HEIGHT }}
      data-slot-bar={tileId}
    >
      <span className="grid shrink-0" title={LOOKS[look].word} data-slot-status={look}><StatusGlyph look={look} className="size-2" /></span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {onSleep && (
        <Button variant="ghost" size="icon-xs" onClick={onSleep} aria-label="Put agent to sleep" title="Sleep: end its process, keep its screen and conversation">
          <Moon />
        </Button>
      )}
      <kbd className="font-mono text-chip text-[var(--color-fg3)]">{actionKey("undock")}</kbd>
      <Button variant="ghost" size="icon-xs" onClick={popOut} aria-label="Pop out to canvas" title="Pop out: show this tile on the canvas">
        <ArrowUpRight />
      </Button>
      <Button variant="ghost" size="icon-xs" onClick={onUndock} aria-label="Undock" title={`Undock (${actionKey("undock")})`}>
        <X />
      </Button>
    </div>
  );
}
