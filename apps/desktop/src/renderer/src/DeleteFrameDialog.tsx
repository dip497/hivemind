/**
 * Deleting a frame that holds tiles asks what becomes of them: kept, running and loose, or closed
 * with it. Focus starts on Keep, so Enter never ends a session.
 */
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";

export interface FrameDeleteAsk { frameId: string; title: string; tiles: number; agents: number }

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function DeleteFrameDialog({ ask, onChoose }: { ask: FrameDeleteAsk | null; onChoose: (choice: "cancel" | "keep" | "close") => void }) {
  const noun = ask && ask.agents === ask.tiles ? "agent" : "tile";
  const what = ask ? (noun === "tile" && ask.agents ? `${count(ask.tiles, "tile")}, ${ask.agents === 1 ? "one of them an agent" : `${ask.agents} of them agents`}` : count(ask.tiles, noun)) : "";
  return (
    <Dialog open={!!ask} onOpenChange={(open) => { if (!open) onChoose("cancel"); }}>
      <DialogContent className="sm:max-w-[440px]" data-delete-frame>
        <DialogTitle>Delete “{ask?.title}”?</DialogTitle>
        <DialogDescription>It holds {what}. Keep them running outside a frame, or close them with it.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onChoose("cancel")}>Cancel</Button>
          <Button variant="outline" autoFocus data-delete-frame-keep onClick={() => onChoose("keep")}>Keep them</Button>
          <Button variant="destructive" data-delete-frame-close onClick={() => onChoose("close")}>Close {ask ? count(ask.tiles, noun) : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
