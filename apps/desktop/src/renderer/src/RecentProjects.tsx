/** Ctrl+R — VS Code's Open Recent: the projects opened before, the workspaces on this person's
 *  hosts (R14) and those shared with them (M1), a way to browse for another, another window on
 *  this one, and quitting. */
import { Suspense, lazy, useEffect, useState } from "react";
import { AppWindow, FolderOpen, History, LogIn, LogOut, Power, Server, Users } from "./components/icons";
import { Dialog, DialogContent, DialogTitle } from "./components/ui/dialog";
import { MenuItem } from "./components/ui/menu-item";
// Joining loads when its page is opened.
const JoinForm = lazy(() => import("./multiplayer/join-form").then((m) => ({ default: m.JoinForm })));

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const parent = (p: string) => p.split("/").slice(0, -1).join("/").replace(/^\/home\/[^/]+/, "~");

export function RecentProjects({ open, joining: joinFirst = false, recents, current, onOpen, onBrowse, onNewWindow, onClose }: {
  open: boolean;
  /** Open on joining a shared workspace rather than on the list. */
  joining?: boolean;
  recents: string[];
  current: string | null;
  onOpen: (path: string) => void;
  onBrowse: () => void;
  onNewWindow: () => void;
  onClose: () => void;
}) {
  // A workspace shared from elsewhere is listed under its name, with the others shared.
  const others = recents.filter((p) => p !== current && !p.startsWith("hive://"));
  // Joining a shared workspace is this dialog's second page, not a dialog of its own.
  const [joining, setJoining] = useState(joinFirst);
  useEffect(() => { if (open) setJoining(joinFirst); }, [open, joinFirst]);
  const [shared, setShared] = useState<Awaited<ReturnType<typeof window.hive.joined>>>([]);
  useEffect(() => {
    if (open) void window.hive.joined().then((all) => setShared((all ?? []).filter((j) => `hive://${j.workspace}` !== current)), () => {});
  }, [open, current]);
  // Asked of each of this person's hosts as the dialog opens: a host that sleeps answers later, or not.
  const [hosts, setHosts] = useState<Awaited<ReturnType<typeof window.hive.deviceWorkspaces>>>([]);
  useEffect(() => {
    if (open) void window.hive.deviceWorkspaces?.().then((all) => setHosts(all ?? []), () => {});
  }, [open]);
  const openOnHost = (device: string, workspace: string, name: string) => {
    onClose();
    void window.hive.openDeviceWorkspace(device, workspace, name).then(onOpen, () => {});
  };
  // A workspace on a host this person already opened is listed with the host, not twice.
  const onHosts = new Set(hosts.flatMap((h) => h.workspaces ?? []).map((w) => w.workspace));
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setJoining(false); } }}>
      <DialogContent padding="none" className="sm:max-w-[480px] overflow-hidden">
        <header className="flex items-center gap-2 px-4 pt-4 pb-2">
          {joining ? <LogIn size={15} className="text-[var(--color-fg3)]" /> : <History size={15} className="text-[var(--color-fg3)]" />}
          <DialogTitle className="h-7 flex items-center">{joining ? "Join a shared workspace" : "Open recent"}</DialogTitle>
        </header>
        {joining ? (
          <Suspense fallback={null}>
            <JoinForm onOpen={(workspace) => { onClose(); setJoining(false); onOpen(`hive://${workspace}`); }} />
          </Suspense>
        ) : (
        <div className="flex flex-col px-2 pb-2" data-recent-projects>
          {others.map((p, i) => (
            <MenuItem key={p} autoFocus={i === 0} data-recent={p} title={p} onClick={() => { onClose(); onOpen(p); }}>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-body text-[var(--color-fg)]">{base(p)}</span>
                <span className="block truncate font-mono text-count text-[var(--color-fg3)]">{parent(p)}</span>
              </span>
            </MenuItem>
          ))}
          {others.length === 0 && (
            <p className="px-2.5 py-2 text-label text-[var(--color-fg3)]">No other project opened yet.</p>
          )}
          {hosts.length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-2 text-count font-medium text-[var(--color-fg3)]">On your devices</div>
              {hosts.map((h) => h.workspaces === null ? (
                <p key={h.device} className="px-2.5 py-1 text-label text-[var(--color-fg3)]" data-host-offline={h.device}>{h.name} does not answer: is it on, with hivemind (or `hive host`) running?</p>
              ) : h.workspaces.filter((w) => `hive://${w.workspace}` !== current).map((w) => (
                <MenuItem key={w.workspace} data-host-workspace={w.workspace} title={w.repo} onClick={() => openOnHost(h.device, w.workspace, w.name)}>
                  <Server />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-body text-[var(--color-fg)]">{w.name}</span>
                    <span className="block truncate text-count text-[var(--color-fg3)]">on {h.name}</span>
                  </span>
                </MenuItem>
              )))}
            </>
          )}
          {shared.filter((j) => !onHosts.has(j.workspace)).length > 0 && (
            <>
              <div className="px-2.5 pb-1 pt-2 text-count font-medium text-[var(--color-fg3)]">Shared with you</div>
              {shared.filter((j) => !onHosts.has(j.workspace)).map((j) => (
                <MenuItem key={j.workspace} data-shared-workspace={j.workspace} onClick={() => { onClose(); onOpen(`hive://${j.workspace}`); }}>
                  <Users />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-body text-[var(--color-fg)]">{j.names.workspace}</span>
                    <span className="block truncate text-count text-[var(--color-fg3)]">
                      {j.ended === "left" ? "You left · the last copy" : j.ended === "removed" ? "Removed · the last copy" : `on ${j.names.host}'s machine`}
                    </span>
                  </span>
                </MenuItem>
              ))}
            </>
          )}
          <div className="my-1 border-t border-[var(--color-line)]" />
          <MenuItem autoFocus={others.length === 0} onClick={() => { onClose(); onBrowse(); }}>
            <FolderOpen /><span className="flex-1">Open folder…</span>
            <kbd className="font-mono text-count text-[var(--color-fg2)]">Ctrl O</kbd>
          </MenuItem>
          <MenuItem data-new-window onClick={() => { onClose(); onNewWindow(); }}>
            <AppWindow /><span className="flex-1">New window</span>
          </MenuItem>
          <MenuItem data-join onClick={() => setJoining(true)}>
            <LogIn /><span className="flex-1">Join a shared workspace…</span>
          </MenuItem>
          {window.hive.quit && window.hive.quitAndStopEverything && (
            <>
              <div className="my-1 border-t border-[var(--color-line)]" />
              <MenuItem data-quit onClick={() => { onClose(); void window.hive.quit?.(); }}>
                <LogOut /><span className="flex-1">Quit</span>
                <kbd className="font-mono text-count text-[var(--color-fg2)]">{window.hive.platform === "darwin" ? "⌘Q" : "Ctrl Q"}</kbd>
              </MenuItem>
              <MenuItem data-quit-stop-agents onClick={() => { onClose(); void window.hive.quitAndStopEverything?.(); }}>
                <Power /><span className="flex-1">Quit and stop agents</span>
              </MenuItem>
            </>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
