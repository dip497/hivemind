/**
 * After a package is installed: "Open Archipelago?" for the view its manifest opens with
 * (`startup.view`), and a button that switches to it. Offered only when the package is on, since
 * a view switched off does not load.
 */
import { Button } from "../components/ui/button";
import { setViewMode } from "../workspace/view-mode-store";
import type { PackageReview } from "../../../shared/ipc";

/** The view to offer once `review`'s package is installed, or null. */
export const startViewOf = (review: Pick<PackageReview, "on" | "opens">): PackageReview["opens"] =>
  review.on ? review.opens : null;

/** Switch to the view a package opens with, as the view switcher does, and close Settings to show it. */
export function openStartView(id: string): void {
  setViewMode(id);
  window.dispatchEvent(new CustomEvent("hivemind:close-settings"));
}

/** The offer, after a package's "is installed" line. */
export function OpenStartView({ view, onOpen }: { view: NonNullable<PackageReview["opens"]>; onOpen?: () => void }) {
  return <>
    <span>Open {view.name}?</span>
    <Button size="sm" data-open-start-view={view.id} onClick={() => { openStartView(view.id); onOpen?.(); }}>Open</Button>
  </>;
}
