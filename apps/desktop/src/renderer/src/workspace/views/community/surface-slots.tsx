/**
 * The hole-punch overlay a view's `surfaceRects` ask for: one live slot per rect, pointer events
 * only on the slots. Unless the rect says `chrome: "none"`, the host's slot bar sits at the top of
 * it (name, status, sleep, pop-out, undock).
 */
import { useEffect, useRef, type RefObject } from "react";
import type { SurfaceRect } from "@hivemind/view-sdk/protocol";
import type { WorkspaceViewProps } from "../../workspace-view";
import type { LayerTile } from "../../../LayersPanel";
import { AGENT_TILE_KIND } from "../../../tile-kinds";
import { inPark, TileSlot } from "../../tile-host";
import { SlotBar } from "../../slot-chrome";
import { Wallpaper } from "../../../Wallpaper";
import { useSurfacePolicy } from "../../../theme-store";

export function SurfaceSlots({ rects, width, tiles, commands, onUndock, frame }: {
  rects: SurfaceRect[];
  /** The view's width: a slot flush with its top-right corner keeps its bar below the app's corner buttons. */
  width: number;
  tiles: ReadonlyMap<string, LayerTile>;
  commands: WorkspaceViewProps["commands"];
  onUndock: (tileId: string) => void;
  /** The view's frame, which gets the keyboard back when a slot that had it goes away. */
  frame: RefObject<HTMLIFrameElement | null>;
}) {
  const policy = useSurfacePolicy();

  // A slot that goes away (undocked from its bar or with Shift+Esc, released by the view, its tile
  // closed) leaves the focus in its surface, now parked out of sight, or on the page: the view's
  // keys do nothing until a click, and in the park every key goes on into a terminal nobody sees.
  // The view gets the keyboard back one frame later, after whatever gives it to something on
  // purpose (a view docking the next tile selects it, which focuses that terminal).
  const shown = useRef<ReadonlySet<string>>(new Set());
  const pending = useRef(0);
  useEffect(() => {
    const was = shown.current;
    shown.current = new Set(rects.map((r) => r.tileId));
    if (pending.current || ![...was].some((id) => !shown.current.has(id))) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      const at = document.activeElement;
      if (!at || at === document.body || inPark(at)) frame.current?.focus();
    });
  }, [rects, frame]);
  useEffect(() => () => cancelAnimationFrame(pending.current), []);

  return (
    <div className="pointer-events-none absolute inset-0" data-community-surfaces>
      {rects.map((r) => {
        const tile = tiles.get(r.tileId);
        return (
          <div
            key={r.tileId}
            className={`${r.inert ? "pointer-events-none [&_*]:!pointer-events-none" : "pointer-events-auto"} absolute flex flex-col overflow-hidden bg-[var(--color-bg)]`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: r.radius, paddingTop: r.y <= 1 && r.x + r.w >= width - 1 ? 48 : 0 }}
            data-community-slot={r.tileId}
            data-slot-bare={r.chrome === "none" ? "" : undefined}
          >
            {/* With pluginSurfaces "theme" the wallpaper is painted behind this slot only, so the
                terminal frosts as on the canvas while nothing full-window is composited. */}
            {policy.slotWallpaper && <Wallpaper embedded />}
            {r.chrome !== "none" && (
              <div className="relative z-10 shrink-0">
                <SlotBar tileId={r.tileId} name={tile?.name ?? r.tileId} commands={commands} onUndock={() => onUndock(r.tileId)}
                  // The tile's own bar, with its Sleep, is hidden in a slot (styles.css): this one has it.
                  onSleep={tile?.kind === AGENT_TILE_KIND && !tile.sleeping ? () => commands.sleepAgent(r.tileId) : undefined} />
              </div>
            )}
            <TileSlot tileId={r.tileId} transient className="relative z-10 min-h-0 flex-1" />
          </div>
        );
      })}
    </div>
  );
}
