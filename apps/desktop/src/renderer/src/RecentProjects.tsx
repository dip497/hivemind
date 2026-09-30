/** Ctrl+R — VS Code's Open Recent: the projects opened before, a way to browse for another, and
 *  another window on this one. */
import { useState } from "react";
import { AppWindow, FolderOpen, History, LogIn } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { MenuItem } from "./components/ui/menu-item";
import { JoinForm } from "./multiplayer/join-form";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const parent = (p: string) => p.split("/").slice(0, -1).join("/").replace(/^\/home\/[^/]+/, "~");

export function RecentProjects({ open, recents, current, onOpen, onBrowse, onNewWindow, onClose }: {
  open: boolean;
  recents: string[];
  current: string | null;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onNewWindow: () => void;
  onClose: () => void;
}) {
  const others = recents.filter((p) => p !== current);
  // Joining a shared workspace is this dialog's second page, not a dialog of its own.
  const [joining, setJoining] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setJoining(false); } }}>
      <DialogContent padding="none" className="sm:max-w-[480px] overflow-hidden">
        <header className="flex items-center gap-2 px-4 pt-4 pb-2">
          {joining ? <LogIn size={15} className="text-[var(--color-fg3)]" /> : <History size={15} className="text-[var(--color-fg3)]" />}
          <DialogTitle className="h-7 flex items-center">{joining ? "Join a shared workspace" : "Open recent"}</DialogTitle>
        </header>
        {joining ? (
          <JoinForm onOpen={(workspace) => { onClose(); setJoining(false); onOpen(`hive://${workspace}`); }} />
        ) : (
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
          <MenuItem data-new-window onClick={() => { onClose(); onNewWindow(); }}>
            <AppWindow /><span className="flex-1">New window</span>
          </MenuItem>
          <MenuItem data-join onClick={() => setJoining(true)}>
            <LogIn /><span className="flex-1">Join a shared workspace…</span>
          </MenuItem>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
