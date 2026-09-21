/** Over a remote terminal while its machine's link is down: the screen is stale, and why. */
import { Button } from "../components/ui/button";
import { useEffect, useState } from "react";
import { hostIdOfUri, machineByHost, openMachines, statusOf, useMachines } from "./store";
import { MachineDot } from "./status";

/** A blip reconnects in milliseconds; only a break long enough to notice is worth a banner. */
const GRACE_MS = 1200;

export function LinkBanner({ cwd }: { cwd: string }) {
  const snap = useMachines();
  const hostId = hostIdOfUri(cwd);
  const s = statusOf(snap, hostId);
  const machine = machineByHost(snap, hostId);
  const off = machine?.enabled === false;
  const down = off || s.state === "reconnecting" || s.state === "attention";
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!down) { setShow(false); return; }
    const t = setTimeout(() => setShow(true), off || s.state === "attention" ? 0 : GRACE_MS);
    return () => clearTimeout(t);
  }, [down, off, s.state]);
  if (!hostId || !down || !show) return null;
  const name = machine?.label ?? hostId.replace(/:22$/, "");
  return (
    <div
      role="status"
      className="absolute left-2 right-2 top-9 z-10 flex items-center gap-2 rounded-md border border-[var(--color-line2)] bg-[color-mix(in_oklab,var(--color-bg2)_92%,transparent)] px-2.5 py-1.5 text-[11.5px] text-[var(--color-fg)] shadow-lg backdrop-blur-sm"
    >
      <MachineDot status={s} enabled={!off} />
      <span className="flex-1 truncate" title={off ? undefined : s.detail} data-link-banner={off ? "off" : s.state}>
        {off ? `${name} is turned off — this terminal keeps running there` : s.state === "attention" ? `${name} needs you to log in again` : `Reconnecting to ${name}…`}
        {!off && s.detail && <span className="text-[var(--color-fg3)]"> {s.detail}</span>}
      </span>
      {off
        ? <Button variant="link" size="xs" onClick={() => void window.hive.machineUpdate(machine.id, { enabled: true })} className="shrink-0">Turn on</Button>
        : s.state === "attention"
        ? <Button variant="link" size="xs" onClick={() => openMachines({ kind: "manage" })} className="shrink-0">Fix</Button>
        : <Button variant="link" size="xs" onClick={() => void window.hive.machineReconnect(hostId)} className="shrink-0">Retry now</Button>}
    </div>
  );
}
