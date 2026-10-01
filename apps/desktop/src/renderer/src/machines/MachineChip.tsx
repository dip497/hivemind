/**
 * The machine a remote frame runs on, in its header: live dot, name, folder, round trip.
 * Clicking opens its status, the sessions already running there, and the frame's actions. On a
 * frame of this person's on this computer, in someone else's workspace (M4), what the others there
 * may do on this computer.
 */
import { MenuItem } from "../components/ui/menu-item";
import { Button } from "../components/ui/button";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, FolderOpen, Loader2, RefreshCw, Server, Settings2, SquareTerminal, Unplug } from "lucide-react";
import type { Grant, SessionSummary } from "../../../shared/ipc";
import { parseDeviceUri, parseRemote, remoteBasename, remotePath, sshTargetOf, REMOTE_SCHEME } from "@hivemind/core/remote-uri";
import { joinedId, useShown } from "../multiplayer/shown";
import { A_DEVICE, GONE_MACHINE, errText, openMachines, ownerOf, ownerStatus, placeOf, statusOf, useMachines, whoseComputer, type Place } from "./store";
import { useMachineOwners } from "./owners";

/** What a frame's machine is called: its saved name, or the device's (M3), else the host an ssh
 *  folder is on, else one no longer saved or paired. */
const nameOf = (uri: string, { machine, device, hostId }: Place) =>
  machine?.label ?? device?.name ?? (hostId?.startsWith("device:") ? A_DEVICE : hostId && uri.startsWith(REMOTE_SCHEME) ? parseRemote(uri).host : GONE_MACHINE);

/** The frame folder `uri`'s machine, its name and how it is doing: on a participant's computer
 *  (M4), theirs, connected or not; else as this machine's links say. */
function useMachineAt(uri: string) {
  const snap = useMachines();
  const place = placeOf(snap, uri);
  const owner = ownerOf(place, uri, useMachineOwners(useShown().repo));
  return { snap, place, owner, name: owner ? whoseComputer(owner) : nameOf(uri, place), status: owner ? ownerStatus(owner) : statusOf(snap, place.hostId) };
}
import { AttentionNote, MachineDot, statusWords } from "./status";
import { openSessionIds } from "./open-sessions";

export function MachineChip({ uri, frameId, onUnbind }: { uri: string; frameId: string; onUnbind: () => void }) {
  const { name, status } = useMachineAt(uri);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={btn}
        onClick={() => setOpen((x) => !x)}
        className="nodrag flex items-center gap-1.5 min-w-0 max-w-[60%] rounded px-1.5 py-0.5 text-[10px] font-mono cursor-pointer hover:brightness-110"
        style={{ background: "color-mix(in oklab, var(--color-brand) 18%, transparent)", color: "var(--color-fg)" }}
        title={`${name} · ${remotePath(uri)} — ${statusWords(status)}`}
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
  const { snap, place, owner, name, status } = useMachineAt(uri);
  const { machine, hostId } = place;
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An ssh folder no machine is saved for can be saved as one; a machine no longer saved cannot.
  const target = machine?.target ?? (hostId && uri.startsWith(REMOTE_SCHEME) ? sshTargetOf(parseRemote(uri)) : undefined);
  // This person's own frame on this computer, in someone else's workspace (M4).
  const { repo, shared } = useShown();
  const theirs = joinedId(repo);
  const othersHere = theirs && shared && shared.access !== "owner" && !!snap.self && parseDeviceUri(uri)?.device === snap.self ? theirs : null;

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
          <span className="truncate">{name}</span>
          <span className="ml-auto text-[11px] font-normal text-[var(--color-fg2)] tabular-nums">{statusWords(status)}</span>
        </span>
        <span className="text-[11px] font-mono text-[var(--color-fg3)] truncate" title={uri}>{remotePath(uri)}</span>
      </div>
      {status.state === "attention" && target && (
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
          {hostId && !owner && <Button variant="link" size="xs" onClick={() => void window.hive.machineReconnect(hostId)} className="shrink-0">Retry now</Button>}
        </div>
      )}
      {status.state === "no-hive" && (
        <p className="mx-1 rounded-md bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-fg2)]">
          No <span className="font-mono">hive</span> there, so terminals stop when the connection drops. Install it from Machines.
        </p>
      )}
      <div className="h-px bg-[var(--color-line2)] my-0.5" />
      {othersHere && <OthersHere workspace={othersHere} />}
      {/* A device's own sessions are its windows' to show. */}
      {place.device || hostId?.startsWith("device:") ? null : sessions === null ? (
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
      {machine ? (
        <MenuItem onClick={() => { onClose(); openMachines({ kind: "pick", frameId, machineId: machine.id }); }}>
          <FolderOpen size={13} /> Change folder…
        </MenuItem>
      ) : !target && (
        <MenuItem onClick={() => { onClose(); openMachines({ kind: "pick", frameId }); }}>
          <FolderOpen size={13} /> Choose where it runs…
        </MenuItem>
      )}
      <MenuItem onClick={() => { onClose(); openMachines(machine || !target ? { kind: "manage" } : { kind: "add", target }); }}>
        {machine || !target ? <Settings2 size={13} /> : <Server size={13} />} {machine || !target ? "Machines…" : "Save as a machine…"}
      </MenuItem>
      <MenuItem onClick={onUnbind} variant="destructive">
        <Unplug size={13} /> Disconnect this frame
      </MenuItem>
    </div>
  );
}

/** What the others in a workspace may do on this computer, in this person's frames here (M4):
 *  theirs to give, and take back at any moment. Everyone there watches what runs here. */
const OTHERS: Array<[Grant, string]> = [
  ["watch", "Only watch what runs here"],
  ["terminals", "Type into it, as its host lets them"],
  ["agents", "Run terminals and agents here too"],
];
/** What a grant beyond watching means for this computer, said under the choice. */
const GIVEN: Partial<Record<Grant, string>> = {
  terminals: "What they type runs on this computer, as you.",
  agents: "What they start runs on this computer, as you, in your frames' folders.",
};

function OthersHere({ workspace }: { workspace: string }) {
  const [grant, setGrant] = useState<Grant | null>(null);
  useEffect(() => {
    let live = true;
    void window.hive.machineGrant(workspace).then((g) => { if (live) setGrant(g); }, () => {});
    return () => { live = false; };
  }, [workspace]);
  const choose = (g: Grant) => {
    setGrant(g);
    void window.hive.setMachineGrant(workspace, g).catch(() => { void window.hive.machineGrant(workspace).then(setGrant, () => {}); });
  };
  return (
    <div className="grid gap-0.5" role="group" aria-label="what others may do here">
      <span className="px-2 pt-1 u-eyebrow">Others in this workspace may</span>
      {OTHERS.map(([g, label]) => (
        <MenuItem key={g} onClick={() => choose(g)} role="menuitemradio" aria-checked={grant === g} data-machine-grant={g}>
          {grant === g ? <Check size={13} /> : <span className="inline-block w-[13px]" />} {label}
        </MenuItem>
      ))}
      {grant && GIVEN[grant] ? <span className="px-2 pb-1 text-[11px] text-muted-foreground">{GIVEN[grant]}</span> : null}
      <div className="h-px bg-[var(--color-line2)] my-0.5" />
    </div>
  );
}
