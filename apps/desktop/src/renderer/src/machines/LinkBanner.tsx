/** Over a remote terminal while its machine's link is down: the screen is stale, and why. */
import { useEffect, useState } from "react";
import { hostIdOfUri, machineByHost, openMachines, statusOf, useMachines } from "./store";
import { MachineDot } from "./status";

/** A blip reconnects in milliseconds; only a break long enough to notice is worth a banner. */
const GRACE_MS = 1200;

export function LinkBanner({ cwd }: { cwd: string }) {
  const snap = useMachines();
  const hostId = hostIdOfUri(cwd);
  const s = statusOf(snap, hostId);
  const down = s.state === "reconnecting" || s.state === "attention";
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!down) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), s.state === "attention" ? 0 : GRACE_MS);
    return () => clearTimeout(t);
  }, [down, s.state]);
  if (!hostId || !down || !show) return null;
  const name = machineByHost(snap, hostId)?.label ?? hostId.replace(/:22$/, "");
  return (
    <div
      role="status"
      className="absolute left-2 right-2 top-9 z-10 flex items-center gap-2 rounded-md border border-[var(--color-line2)] bg-[color-mix(in_oklab,var(--color-bg2)_92%,transparent)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-fg)] shadow-lg backdrop-blur-sm"
    >
      <MachineDot status={s} />
      <span className="flex-1 truncate" title={s.detail}>
        {s.state === "attention" ? `${name} needs you to log in again` : `Reconnecting to ${name}…`}
        {s.detail && <span className="text-[var(--color-fg3)]"> {s.detail}</span>}
      </span>
      {s.state === "attention"
        ? <button onClick={() => openMachines({ kind: "manage" })} className="shrink-0 text-[var(--color-brand)] hover:underline cursor-pointer">Fix</button>
        : <button onClick={() => void window.hive.machineReconnect(hostId)} className="shrink-0 text-[var(--color-brand)] hover:underline cursor-pointer">Retry now</button>}
    </div>
  );
}
