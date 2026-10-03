/**
 * The slim banner over a workspace joined from elsewhere (design §4.2 B, F): whose it is and what
 * this person may do there while connected; amber while it reconnects; grey while its host cannot
 * be reached, with the last board shown; and how it ended (left, or removed), when what is shown
 * is the last copy, which is only read. Leave is here, and, on a workspace of yours that was moved
 * from this computer to another of your devices, Move here (§5.7 F), or, while that device cannot
 * be reached, Host it here, from the board as it was last seen (§5.7 E).
 */
import { useEffect, useState } from "react";
import { House, LogOut } from "lucide-react";
import type { SharedStatus } from "../../../shared/ipc";
import { Button } from "../components/ui/button";
import { ROLE_LABELS } from "./people";
import { joinedId, useShown, type Shared } from "./shown";

function says(s: Shared): string {
  const { workspace, host } = s.names;
  switch (s.state) {
    case "connecting": return `Connecting to ${host}'s hivemind…`;
    case "connected": return `You're in ${workspace} on ${host}'s machine · ${ROLE_LABELS[s.access] ?? s.access}`;
    case "reconnecting": return "Reconnecting…";
    case "offline": return `${host}'s hivemind isn't online. Showing the last board; we'll connect when it is.`;
    case "left": return `You left ${workspace}. This is the last copy you had, to read.`;
    case "removed": return `You were removed from ${workspace}. This is the last copy you had, to read.`;
  }
}

const TONE: Record<SharedStatus["state"], string> = {
  connecting: "border-[var(--color-line)] text-[var(--color-fg2)]",
  connected: "border-[var(--color-line)] text-[var(--color-fg2)]",
  reconnecting: "border-[var(--color-warn)] text-[var(--color-warn)]",
  offline: "border-[var(--color-line)] text-[var(--color-fg3)]",
  left: "border-[var(--color-line)] text-[var(--color-fg3)]",
  removed: "border-[var(--color-err)] text-[var(--color-err)]",
};

export function SharedBanner({ onMoved }: { onMoved: (folder: string) => void }) {
  const { repo, shared: status } = useShown();
  const workspace = joinedId(repo);
  // Its folder on this computer, when it was moved from here: it can come back.
  const [home, setHome] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = status?.access === "owner";
  useEffect(() => {
    setHome(null);
    setError(null);
    if (workspace && owner) void window.hive.folderHere(workspace).then(setHome, () => setHome(null));
  }, [workspace, owner]);
  if (!workspace || !status) return null;
  const ended = status.state === "left" || status.state === "removed";
  const bringHere = async (how: (workspace: string) => Promise<string>) => {
    setMoving(true);
    setError(null);
    try {
      onMoved(await how(workspace));
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    } finally {
      setMoving(false);
    }
  };
  return (
    <div
      className={`pointer-events-auto flex items-center gap-2 rounded-md border bg-[var(--color-bg2)] px-2.5 py-1 text-[12px] shadow-sm ${TONE[status.state]}`}
      data-shared-banner
      data-state={status.state}
      data-access={status.access}
      role="status"
    >
      <span className="max-w-[520px] truncate">{says(status)}</span>
      {error && <span className="max-w-[260px] truncate text-[var(--color-err)]" role="alert" title={error}>{error}</span>}
      {home && status.state === "connected" && (
        <Button size="sm" variant="ghost" disabled={moving} onClick={() => void bringHere(window.hive.moveHostingHere)} title={`Host it on this computer again, from ${home}`} data-move-here>
          <House /> {moving ? "Moving…" : "Move here"}
        </Button>
      )}
      {home && status.state === "offline" && (
        <Button size="sm" variant="ghost" disabled={moving} onClick={() => void bringHere(window.hive.takeOver)} title={`Host it on this computer again, from ${home}, as it was last seen here`} data-take-over>
          <House /> {moving ? "Taking over…" : "Host it here"}
        </Button>
      )}
      {!ended && (
        <Button size="sm" variant="ghost" onClick={() => void window.hive.leave(workspace)} data-leave>
          <LogOut /> Leave
        </Button>
      )}
    </div>
  );
}
