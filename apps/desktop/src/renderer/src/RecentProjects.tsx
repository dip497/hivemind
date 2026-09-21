/** Ctrl+R — VS Code's Open Recent: the projects opened before, and a way to browse for another. */
import { FolderOpen, History } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { MenuItem } from "./components/ui/menu-item";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const parent = (p: string) => p.split("/").slice(0, -1).join("/").replace(/^\/home\/[^/]+/, "~");

export function RecentProjects({ open, recents, current, onOpen, onBrowse, onClose }: {
  open: boolean;
  recents: string[];
  current: string | null;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onClose: () => void;
}) {
  const others = recents.filter((p) => p !== current);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent padding="none" className="sm:max-w-[480px] overflow-hidden">
        <header className="flex items-center gap-2 px-4 pt-4 pb-2">
          <History size={15} className="text-[var(--color-fg3)]" />
          <DialogTitle className="h-7 flex items-center">Open recent</DialogTitle>
        </header>
        <div className="flex flex-col px-2 pb-2" data-recent-projects>
          {others.map((p, i) => (
            <MenuItem key={p} autoFocus={i === 0} data-recent={p} title={p} onClick={() => { onClose(); onOpen(p); }}>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[13px] text-[var(--color-fg)]">{base(p)}</span>
                <span className="block truncate font-mono text-[11px] text-[var(--color-fg3)]">{parent(p)}</span>
              </span>
            </MenuItem>
          ))}
          {others.length === 0 && (
            <p className="px-2.5 py-2 text-[12px] text-[var(--color-fg3)]">No other project opened yet.</p>
          )}
          <div className="my-1 border-t border-[var(--color-line)]" />
          <MenuItem autoFocus={others.length === 0} onClick={() => { onClose(); onBrowse(); }}>
            <FolderOpen /><span className="flex-1">Open folder…</span>
            <kbd className="font-mono text-[10.5px] text-[var(--color-fg2)]">Ctrl O</kbd>
          </MenuItem>
        </div>
      </DialogContent>
    </Dialog>
  );
}
