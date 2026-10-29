/**
 * After a package is installed: "Open Archipelago?" for the view its manifest opens with
 * (`startup.view`), and "Use Bees as your background?" for the live wallpaper it offers
 * (`startup.wallpaper`), each with a button that switches to it. Offered only when the package is
 * on, since a view or wallpaper switched off does not load. Settings shows it under its own install;
 * a package installed anywhere else (`hive plugins install`, while the app runs or before it
 * started) is offered as a toast, once, as main's start-view-offers.ts decides. Nothing switches
 * without the person's button.
 */
import { useEffect } from "react";
import type { WallpaperKind } from "@hivemind/core/settings-schema";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { getViewMode, setViewMode } from "../workspace/view-mode-store";
import { getView, listViews, resolveViewId } from "../workspace/workspace-view";
import { useCommunityReport } from "../workspace/views/community/registry";
import { getTheme, setTheme } from "../theme-store";
import { reloadWallpapers, wallpaperName } from "../live/wallpaper-store";
import type { PackageReview } from "../../../shared/ipc";

/** The view to offer once `review`'s package is installed, or null. */
export const startViewOf = (review: Pick<PackageReview, "on" | "opens">): PackageReview["opens"] =>
  review.on ? review.opens : null;

/** The live wallpaper to offer once `review`'s package is installed, or null. */
export const startWallpaperOf = (review: Pick<PackageReview, "on" | "wallpaper">): PackageReview["wallpaper"] =>
  review.on ? review.wallpaper : null;

/** Switch to the view a package opens with, as the view switcher does, and close Settings to show it. */
export function openStartView(id: string): void {
  setViewMode(id);
  window.dispatchEvent(new CustomEvent("hivemind:close-settings"));
}

/** Draw a package's live wallpaper behind the canvas, as picking it in Settings ▸ Appearance does. */
export function chooseStartWallpaper(id: string): void {
  void reloadWallpapers();
  setTheme({ wallpaper: id as WallpaperKind });
}

type Named = { id: string; name: string };

/** "Harbour is installed. Open Isle?", "Use Bees as your background?", or both, and their buttons,
 *  for the package named `installed`. */
export function OpenStartView({ installed, view, wallpaper, onOpen }: { installed: string; view?: Named | null; wallpaper?: Named | null; onOpen?: () => void }) {
  const question = view && wallpaper ? `Open ${view.name}, or use ${wallpaper.name} as your background?`
    : view ? `Open ${view.name}?` : wallpaper ? `Use ${wallpaper.name} as your background?` : "";
  return <>
    <span>{installed} is installed.{question ? ` ${question}` : ""}</span>
    {view && <Button size="sm" data-open-start-view={view.id} onClick={() => { openStartView(view.id); onOpen?.(); }}>Open</Button>}
    {wallpaper && <Button size="sm" variant={view ? "outline" : "default"} data-use-start-wallpaper={wallpaper.id} onClick={() => { chooseStartWallpaper(wallpaper.id); onOpen?.(); }}>Use as background</Button>}
  </>;
}

/** Each time this window has loaded its views, ask main which start views and wallpapers to offer,
 *  and offer each package's as a toast that stays until the person takes it or closes it. Views
 *  load at start and on a rescan (an install, a switch), a few times a session: one small ask each.
 *  A component of its own, drawing nothing, so a views load re-renders only it. */
export function StartViewOffers(): null {
  const report = useCommunityReport();
  useEffect(() => {
    const ask = window.hive.startViewOffers;
    if (!ask) return;
    // Shown even when the views loaded again meanwhile: main has recorded these as offered.
    ask(listViews().map((v) => v.id), resolveViewId(getViewMode()), getTheme().wallpaper).then(async (offers) => {
      // A wallpaper is named as its manifest names it: the list again, for one just installed.
      if (offers.some((o) => o.wallpaper)) await reloadWallpapers();
      for (const o of offers) {
        const id = `start-view:${o.package}`;
        const view = o.view ? { id: o.view, name: getView(o.view)?.label ?? o.view } : null;
        const wallpaper = o.wallpaper ? { id: o.wallpaper, name: wallpaperName(o.wallpaper) } : null;
        toast(<div className="flex items-center gap-3" data-start-view-offer={o.package}>
          <OpenStartView installed={o.name} view={view} wallpaper={wallpaper} onOpen={() => toast.dismiss(id)} />
        </div>, { id, duration: Infinity, closeButton: true });
      }
    }, (e: unknown) => console.warn("[hivemind] start view offers:", e));
  }, [report]);
  return null;
}
