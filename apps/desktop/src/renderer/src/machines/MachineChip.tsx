/**
 * The machine a remote frame runs on, in its header: live dot, name, folder, round trip.
 * Clicking opens its status, the sessions already running there, and the frame's actions.
 */
import { MenuItem } from "../components/ui/menu-item";
import { Button } from "../components/ui/button";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Loader2, RefreshCw, Server, Settings2, SquareTerminal, Unplug } from "lucide-react";
import type { SessionSummary } from "../../../shared/ipc";
import { parseRemote, remoteBasename, sshTargetOf } from "../../../shared/remote-uri";
import { errText, hostIdOfUri, machineByHost, openMachines, statusOf, useMachines } from "./store";
import { AttentionNote, MachineDot, statusWords } from "./status";
import { openSessionIds } from "./open-sessions";

export function MachineChip({ uri, frameId, onUnbind }: { uri: string; frameId: string; onUnbind: () => void }) {
  const snap = useMachines();
  const hostId = hostIdOfUri(uri);
  const machine = machineByHost(snap, hostId);
  const status = statusOf(snap, hostId);
  const t = parseRemote(uri);
  const name = machine?.label ?? t.host;
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((x) => !x)}
        className="nodrag flex items-center gap-1.5 min-w-0 max-w-[60%] rounded px-1.5 py-0.5 text-[10px] font-mono cursor-pointer hover:brightness-110"
        style={{ background: "color-mix(in oklab, var(--color-brand) 18%, transparent)", color: "var(--color-fg)" }}
        title={`${name} · ${t.path} — ${statusWords(status)}`}
        aria-label={`machine ${name}`}
        data-machine-state={status.state}
      >
        <MachineDot status={status} />
        <span className="truncate">{name}<span className="text-[var(--color-fg3)]">:{remoteBasename(uri)}</span></span>
        {status.state === "online" && status.rttMs !== undefined && <span className="shrink-0 text-[var(--color-fg3)] tabular-nums">{status.rttMs}ms</span>}
        {status.state !== "online" && status.state !== "idle" && <span className="shrink-0 text-[var(--color-fg2)]">{statusWords(status)}</span>}
      </button>
      {open && btn.current && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <MachinePanel
            anchor={btn.current.getBoundingClientRect()}
            uri={uri}
            frameId={frameId}
            onUnbind={() => { setOpen(false); onUnbind(); }}
            onClose={() => setOpen(false)}
          />
        </>,
        document.body,
      )}
    </>
  );
}

function MachinePanel({ anchor, uri, frameId, onUnbind, onClose }: { anchor: DOMRect; uri: string; frameId: string; onUnbind: () => void; onClose: () => void }) {
  const snap = useMachines();
  const hostId = hostIdOfUri(uri);
  const machine = machineByHost(snap, hostId);
  const status = statusOf(snap, hostId);
  const t = parseRemote(uri);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = machine?.target ?? sshTargetOf(t);

  async function loadSessions() {
    setLoading(true);
    setError(null);
    try { setSessions(await window.hive.machineSessions(uri)); } catch (e) { setError(errText(e)); }
    setLoading(false);
  }
  // Frozen ones would re-run their command on attach; only a running job can be adopted.
  const shown = (sessions ?? []).filter((s) => s.state === "live" && !openSessionIds().has(s.id));

  return (
    <div
      className="hm-popover fixed z-[9999] w-[300px] flex flex-col gap-1"
      style={{ top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 308)) }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="machine"
    >
      <div className="px-2 pt-1.5 pb-1 grid gap-0.5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--color-fg)]">
          <MachineDot status={status} size={8} />
          <span className="truncate">{machine?.label ?? t.host}</span>
          <span className="ml-auto text-[11px] font-normal text-[var(--color-fg2)] tabular-nums">{statusWords(status)}</span>
        </span>
        <span className="text-[11px] font-mono text-[var(--color-fg3)] truncate" title={uri}>{t.path}</span>
      </div>
      {status.state === "attention" && (
        <div className="px-1">
          <AttentionNote
            target={target}
            detail={status.detail}
            needsPassword={status.needsPassword}
            onSetPassword={() => { onClose(); openMachines({ kind: "manage" }); }}
          />
        </div>
      )}
      {(status.state === "reconnecting" || status.state === "offline") && (
        <div className="mx-1 flex items-center gap-2 rounded-md bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-fg2)]">
          <span className="flex-1 truncate" title={status.detail}>{status.detail ?? "Waiting for the network…"}</span>
          {hostId && <Button variant="link" size="xs" onClick={() => void window.hive.machineReconnect(hostId)} className="shrink-0">Retry now</Button>}
        </div>
      )}
      {status.state === "no-hive" && (
        <p className="mx-1 rounded-md bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-fg2)]">
          No <span className="font-mono">hive</span> there, so terminals stop when the connection drops. Install it from Machines.
        </p>
      )}
      <div className="h-px bg-[var(--color-line2)] my-0.5" />
      {sessions === null ? (
        <MenuItem onClick={() => void loadSessions()} disabled={loading}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <SquareTerminal size={13} />} Sessions running there…
        </MenuItem>
      ) : (
        <div className="grid gap-0.5">
          <span className="flex items-center px-2 pt-1 u-eyebrow">
            Running there
            <Button variant="ghost" size="icon-xs" onClick={() => void loadSessions()} aria-label="refresh sessions" className="ml-auto"><RefreshCw className={loading ? "animate-spin" : ""} /></Button>
          </span>
          {shown.length === 0 && <span className="px-2 py-1 text-[11.5px] text-[var(--color-fg3)]">Nothing that isn't already on the canvas.</span>}
          <div className="max-h-[220px] overflow-y-auto overflow-x-hidden grid grid-cols-[minmax(0,1fr)] gap-0.5">
            {shown.map((s) => (
              <MenuItem
                key={s.id}
                onClick={() => { window.dispatchEvent(new CustomEvent("hivemind:open-session", { detail: { frameId, session: s } })); onClose(); }}
                className="items-start"
                title={`Open ${s.id} in this frame`}
              >
                <span className="mt-1 size-1.5 shrink-0 rounded-full" style={{ background: s.state === "live" ? "var(--color-ok)" : "var(--color-fg3)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.title || [s.cmd, ...s.args].join(" ")}</span>
                  <span className="block truncate text-[10.5px] font-mono text-[var(--color-fg3)]">{s.id} · {s.cwd}{s.viewers ? ` · ${s.viewers} watching` : ""}</span>
                </span>
              </MenuItem>
            ))}
          </div>
        </div>
      )}
      {error && <p className="px-2 text-[11px] text-[var(--color-err)] break-words">{error}</p>}
      <div className="h-px bg-[var(--color-line2)] my-0.5" />
      {machine && (
        <MenuItem onClick={() => { onClose(); openMachines({ kind: "pick", frameId, machineId: machine.id }); }}>
          <FolderOpen size={13} /> Change folder…
        </MenuItem>
      )}
      <MenuItem onClick={() => { onClose(); openMachines(machine ? { kind: "manage" } : { kind: "add", target }); }}>
        {machine ? <Settings2 size={13} /> : <Server size={13} />} {machine ? "Machines…" : "Save as a machine…"}
      </MenuItem>
      <MenuItem onClick={onUnbind} variant="destructive">
        <Unplug size={13} /> Disconnect this frame
      </MenuItem>
    </div>
  );
}
