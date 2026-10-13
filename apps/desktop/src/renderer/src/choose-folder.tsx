/**
 * A folder on the computer the app runs on: its system picker where the window has one, else the
 * path typed in (a browser tab has no picker for that computer's folders).
 */
import { useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

let answer: ((path: string | null) => void) | null = null;
const listeners = new Set<() => void>();
const tell = (): void => { for (const l of listeners) l(); };

export function chooseFolder(): Promise<string | null> {
  if (window.hive.pickProjectFolder) return window.hive.pickProjectFolder();
  answer?.(null);
  return new Promise((resolve) => {
    answer = (path) => {
      answer = null;
      tell();
      resolve(path);
    };
    tell();
  });
}

export function FolderPathDialog() {
  const open = useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => answer !== null);
  const [path, setPath] = useState("");
  const done = (value: string | null) => {
    answer?.(value);
    setPath("");
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) done(null); }}>
      <DialogContent className="sm:max-w-[520px]" data-folder-path>
        <DialogTitle>Open a folder</DialogTitle>
        <DialogDescription>Its path on the computer the app runs on.</DialogDescription>
        <form onSubmit={(e) => { e.preventDefault(); if (path.trim()) done(path.trim()); }}>
          <Input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/project" spellCheck={false} aria-label="Folder path" />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={() => done(null)}>Cancel</Button>
            <Button type="submit" disabled={!path.trim()}>Open</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
