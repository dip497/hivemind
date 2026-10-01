/**
 * The machine a remote frame runs on, in its header: live dot, name, folder, round trip.
 * Clicking opens its panel (`MachinePanel.tsx`, loaded then): its status, the sessions already
 * running there, and the frame's actions.
 */
import { lazy, Suspense, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { remoteBasename, remotePath } from "@hivemind/core/remote-uri";
import { MachineDot, statusWords } from "./status";
import { useMachineAt } from "./machine-at";

const MachinePanel = lazy(() => import("./MachinePanel"));

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
          <Suspense fallback={null}>
            <MachinePanel
              anchor={btn.current.getBoundingClientRect()}
              uri={uri}
              frameId={frameId}
              onUnbind={() => { setOpen(false); onUnbind(); }}
              onClose={() => setOpen(false)}
            />
          </Suspense>
        </>,
        document.body,
      )}
    </>
  );
}
