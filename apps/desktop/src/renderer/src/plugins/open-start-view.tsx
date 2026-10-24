/**
 * After a package is installed: "Open Archipelago?" for the view its manifest opens with
 * (`startup.view`), and a button that switches to it. Offered only when the package is on, since
 * a view switched off does not load. Settings shows it under its own install; a package installed
 * anywhere else (`hive plugins install`, while the app runs or before it started) is offered as a
 * toast, once, as main's start-view-offers.ts decides.
 */
import { useEffect } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import { getViewMode, setViewMode } from "../workspace/view-mode-store";
import { getView, listViews, resolveViewId } from "../workspace/workspace-view";
import { useCommunityReport } from "../workspace/views/community/registry";
import type { PackageReview } from "../../../shared/ipc";

/** The view to offer once `review`'s package is installed, or null. */
export const startViewOf = (review: Pick<PackageReview, "on" | "opens">): PackageReview["opens"] =>
  review.on ? review.opens : null;

/** Switch to the view a package opens with, as the view switcher does, and close Settings to show it. */
export function openStartView(id: string): void {
  setViewMode(id);
  window.dispatchEvent(new CustomEvent("hivemind:close-settings"));
}

/** "Harbour is installed. Open Isle?" and its button, for the package named `installed`. */
export function OpenStartView({ installed, view, onOpen }: { installed: string; view: NonNullable<PackageReview["opens"]>; onOpen?: () => void }) {
  return <>
    <span>{installed} is installed. Open {view.name}?</span>
    <Button size="sm" data-open-start-view={view.id} onClick={() => { openStartView(view.id); onOpen?.(); }}>Open</Button>
  </>;
}

/** Each time this window has loaded its views, ask main which start views to offer, and offer
 *  each as a toast that stays until the person opens or closes it. Views load at start and on a
 *  rescan (an install, a switch), a few times a session: one small ask each. A component of its
 *  own, drawing nothing, so a views load re-renders only it. */
export function StartViewOffers(): null {
  const report = useCommunityReport();
  useEffect(() => {
    const ask = window.hive.startViewOffers;
    if (!ask) return;
    // Shown even when the views loaded again meanwhile: main has recorded these as offered.
    ask(listViews().map((v) => v.id), resolveViewId(getViewMode())).then((offers) => {
      for (const o of offers) {
        const id = `start-view:${o.package}`;
        const view = { id: o.view, name: getView(o.view)?.label ?? o.view };
        toast(<div className="flex items-center gap-3" data-start-view-offer={o.package}>
          <OpenStartView installed={o.name} view={view} onOpen={() => toast.dismiss(id)} />
        </div>, { id, duration: Infinity, closeButton: true });
      }
    }, (e: unknown) => console.warn("[hivemind] start view offers:", e));
  }, [report]);
  return null;
}
