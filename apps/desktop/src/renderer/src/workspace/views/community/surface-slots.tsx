/**
 * The hole-punch overlay a view's `surfaceRects` ask for: one live slot per rect, pointer events
 * only on the slots. Unless the rect says `chrome: "none"`, the host's slot bar sits at the top of
 * it (name, status, pop-out, undock).
 */
import type { SurfaceRect } from "@hivemind/view-sdk/protocol";
import type { WorkspaceViewProps } from "../../workspace-view";
import { TileSlot } from "../../tile-host";
import { SlotBar } from "../../slot-chrome";
import { Wallpaper } from "../../../Wallpaper";
import { useSurfacePolicy } from "../../../theme-store";

export function SurfaceSlots({ rects, width, names, commands, onUndock }: {
  rects: SurfaceRect[];
  /** The view's width: a slot flush with its top-right corner keeps its bar below the app's corner buttons. */
  width: number;
  names: ReadonlyMap<string, string>;
  commands: WorkspaceViewProps["commands"];
  onUndock: (tileId: string) => void;
}) {
  const policy = useSurfacePolicy();
  return (
    <div className="pointer-events-none absolute inset-0" data-community-surfaces>
      {rects.map((r) => (
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
              <SlotBar tileId={r.tileId} name={names.get(r.tileId) ?? r.tileId} commands={commands} onUndock={() => onUndock(r.tileId)} />
            </div>
          )}
          <TileSlot tileId={r.tileId} transient className="relative z-10 min-h-0 flex-1" />
        </div>
      ))}
    </div>
  );
}
