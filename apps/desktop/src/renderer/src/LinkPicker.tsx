/** The terminal's "Open detected link": the addresses and paths on its screen, newest first; the
 *  arrows choose, Enter opens where a click would. */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";

export interface PickedLink { text: string; folder: string | null }

export function LinkPicker({ links, onPick, onClose }: { links: PickedLink[] | null; onPick: (l: PickedLink) => void; onClose: () => void }) {
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [links]);
  const list = links ?? [];
  return (
    <Dialog open={!!links} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[560px]" data-link-picker
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(i + 1, list.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Enter" && list[at]) { e.preventDefault(); onPick(list[at]); }
        }}>
        <DialogTitle>Open a link</DialogTitle>
        <DialogDescription>{list.length ? "On the screen, newest first. Enter opens it." : "No link or path is on the screen."}</DialogDescription>
        <ul role="listbox" aria-label="Links on the screen" className="m-0 flex max-h-80 list-none flex-col gap-0.5 overflow-auto p-0">
          {list.map((l, i) => (
            <li key={l.text} role="option" aria-selected={i === at}
              className={`cursor-pointer truncate rounded-md px-2 py-1 font-mono text-label ${i === at ? "bg-[var(--color-bg4)] text-[var(--color-fg)]" : "text-[var(--color-fg2)]"}`}
              onMouseEnter={() => setAt(i)} onClick={() => onPick(l)}>{l.text}</li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
