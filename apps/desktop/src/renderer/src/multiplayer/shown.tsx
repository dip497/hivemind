/**
 * The workspace a window shows, for what is drawn inside it far from where the window chose it (a
 * terminal's keyboard, in a tile the tile host draws; the banner over one joined from elsewhere):
 * its repo, and when it was joined from elsewhere, where the connection to its host is and what
 * this person may do there. Asked once per window, here. A joined workspace is shown in its host's
 * look; this person's own, and leaving one, in theirs.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SharedStatus } from "../../../shared/ipc";
import { showHostLook } from "../theme-store";

export type Shared = { names: { workspace: string; host: string } } & SharedStatus;

interface Shown {
  /** A path, or `hive://<id>` for a workspace joined from elsewhere. */
  repo: string | null;
  /** Where the connection to its host is: null for one of this machine's, and while unknown. */
  shared: Shared | null;
}

const ShownWorkspace = createContext<Shown>({ repo: null, shared: null });

export const useShown = (): Shown => useContext(ShownWorkspace);

/** The id of a workspace joined from elsewhere, from its `hive://` name; null for one of this
 *  machine's. */
export const joinedId = (repo: string | null): string | null => (repo?.startsWith("hive://") ? repo.slice("hive://".length) : null);

export function ShownWorkspaceProvider({ repo, children }: { repo: string | null; children: ReactNode }) {
  const workspace = joinedId(repo);
  const [shared, setShared] = useState<Shared | null>(null);
  useEffect(() => {
    setShared(null);
    if (!workspace) return undefined;
    let live = true;
    void window.hive.sharedStatus(workspace).then((s) => { if (live) setShared(s); }, () => {});
    const off = window.hive.onSharedStatus((ws, s) => {
      if (ws === workspace) setShared((prev) => (prev ? { ...prev, ...s } : prev));
    });
    return () => { live = false; off(); };
  }, [workspace]);
  useEffect(() => {
    if (!workspace) return showHostLook(null);
    let live = true;
    void window.hive.sharedLooks(workspace).then((look) => { if (live && look) showHostLook(look); }, () => {});
    const off = window.hive.onSharedLooks((ws, look) => { if (ws === workspace) showHostLook(look); });
    return () => { live = false; off(); showHostLook(null); };
  }, [workspace]);
  const value = useMemo(() => ({ repo, shared }), [repo, shared]);
  return <ShownWorkspace.Provider value={value}>{children}</ShownWorkspace.Provider>;
}
