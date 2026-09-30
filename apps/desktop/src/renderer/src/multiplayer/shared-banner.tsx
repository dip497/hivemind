/**
 * The slim banner over a workspace joined from elsewhere (design §4.2 B, F): whose it is and what
 * this person may do there while connected; amber while it reconnects; grey while its host cannot
 * be reached, with the last board shown; and how it ended (left, or removed), when what is shown
 * is the last copy, which is only read. Leave is here.
 */
import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import type { SharedStatus } from "../../../shared/ipc";
import { Button } from "../components/ui/button";
import { ROLE_LABELS } from "./share-dialog";

type Status = { names: { workspace: string; host: string } } & SharedStatus;

function says(s: Status): string {
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

export function SharedBanner({ repo }: { repo: string }) {
  const workspace = repo.slice("hive://".length);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let live = true;
    void window.hive.sharedStatus(workspace).then((s) => { if (live) setStatus(s); }, () => {});
    const off = window.hive.onSharedStatus((ws, s) => {
      if (ws === workspace) setStatus((prev) => (prev ? { ...prev, ...s } : prev));
    });
    return () => { live = false; off(); };
  }, [workspace]);
  if (!status) return null;
  const ended = status.state === "left" || status.state === "removed";
  return (
    <div
      className={`pointer-events-auto flex items-center gap-2 rounded-md border bg-[var(--color-bg2)] px-2.5 py-1 text-[12px] shadow-sm ${TONE[status.state]}`}
      data-shared-banner
      data-state={status.state}
      data-access={status.access}
      role="status"
    >
      <span className="max-w-[520px] truncate">{says(status)}</span>
      {!ended && (
        <Button size="sm" variant="ghost" onClick={() => void window.hive.leave(workspace)} data-leave>
          <LogOut aria-hidden /> Leave
        </Button>
      )}
    </div>
  );
}
