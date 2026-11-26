/**
 * Closing a tile that holds unsaved work asks first. A tile says how to read its unsaved work
 * (`reportUnsaved`), read only when the person closes it, so typing costs nothing here.
 */
import { useState } from "react";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";

export interface UnsavedWork {
  /** What is unsaved, as the person names it (file paths). */
  files: string[];
  /** Save it all; false when something could not be saved. */
  saveAll(): Promise<boolean>;
}

const readers = new Map<string, () => UnsavedWork | null>();

/** `tileId` holds unsaved work that `read` says; null: it no longer says. */
export function reportUnsaved(tileId: string, read: (() => UnsavedWork | null) | null): void {
  if (read) readers.set(tileId, read);
  else readers.delete(tileId);
}

/** What `tileId` holds unsaved now, null when nothing. */
export function unsavedIn(tileId: string): UnsavedWork | null {
  const work = readers.get(tileId)?.();
  return work && work.files.length ? work : null;
}

/** Save all / Don't save / Cancel for closing a tile with unsaved work; `onDone(true)` closes it. */
export function UnsavedCloseDialog({ work, onDone }: { work: UnsavedWork | null; onDone: (close: boolean) => void }) {
  const [saving, setSaving] = useState(false);
  const n = work?.files.length ?? 0;
  const names = work?.files.map((f) => f.split("/").pop()).join(", ") ?? "";
  const saveAll = async () => {
    if (!work) return;
    setSaving(true);
    const saved = await work.saveAll().finally(() => setSaving(false));
    if (saved) onDone(true);
  };
  return (
    <Dialog open={!!work} onOpenChange={(open) => { if (!open && !saving) onDone(false); }}>
      <DialogContent className="sm:max-w-[440px]" data-unsaved-tile-close>
        <DialogTitle>Save changes to {n === 1 ? names : `${n} files`}?</DialogTitle>
        <DialogDescription>{n === 1 ? "Your changes are" : `${names}: your changes are`} lost if you close it without saving.</DialogDescription>
        <DialogFooter>
          <Button variant="ghost" disabled={saving} onClick={() => onDone(false)}>Cancel</Button>
          <Button variant="outline" disabled={saving} onClick={() => onDone(true)}>Don't save</Button>
          <Button autoFocus disabled={saving} onClick={() => void saveAll()}>{n === 1 ? "Save" : "Save all"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
