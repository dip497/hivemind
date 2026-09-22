/**
 * The host's confirm for a view's `share` request: the user sees the exact image that would
 * leave the app and chooses copy, save or cancel. The view never sees a path.
 */
import type { SharePrepared } from "../../../../../shared/ipc";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";

export type ShareChoice = "copy" | "save" | "cancel";

export function ShareDialog({ viewName, image, onChoose }: { viewName: string; image: SharePrepared | null; onChoose: (c: ShareChoice) => void }) {
  return (
    <Dialog open={!!image} onOpenChange={(open) => { if (!open) onChoose("cancel"); }}>
      <DialogContent className="sm:max-w-[640px]" data-share-dialog>
        <DialogTitle>{viewName} wants to share this image</DialogTitle>
        <DialogDescription>Nothing leaves the app unless you copy or save it.</DialogDescription>
        {image && (
          <img
            src={image.preview}
            alt={`Image from ${viewName}, ${image.width} by ${image.height} pixels`}
            className="max-h-[50vh] w-full rounded-[var(--radius)] border border-[var(--color-line)] object-contain"
          />
        )}
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onChoose("cancel")}>Cancel</Button>
          <Button variant="secondary" onClick={() => onChoose("save")}>Save…</Button>
          <Button onClick={() => onChoose("copy")}>Copy image</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
