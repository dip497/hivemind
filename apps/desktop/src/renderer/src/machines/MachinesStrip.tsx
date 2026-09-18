/** Layers footer: every machine at a glance (state, round trip); a click opens Machines. */
import { MenuItem } from "../components/ui/menu-item";
import { Button } from "../components/ui/button";
import { Plus, Server } from "lucide-react";
import { openMachines, statusOf, useMachines } from "./store";
import { MachineDot, statusWords } from "./status";

export function MachinesStrip() {
  const snap = useMachines();
  return (
    <section className="shrink-0 max-h-[40%] overflow-y-auto border-t border-[var(--color-line)] px-2 py-1.5" aria-label="machines">
      <div className="flex items-center gap-1.5 h-6 px-1">
        <button onClick={() => openMachines({ kind: "manage" })} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)] hover:text-[var(--color-fg)] cursor-pointer">
          <Server size={12} /> Machines
        </button>
        <Button variant="ghost" size="icon-xs" onClick={() => openMachines({ kind: "add" })} className="ml-auto" title="Add a machine" aria-label="add machine">
          <Plus />
        </Button>
      </div>
      {snap.machines.map((m) => {
        const s = statusOf(snap, m.hostId);
        return (
          <MenuItem
            key={m.id}
            size="sm"
            variant="muted"
            onClick={() => openMachines({ kind: "manage" })}
            className="h-7"
            title={`${m.target}${s.detail ? ` — ${s.detail}` : ""}`}
          >
            <MachineDot status={s} enabled={m.enabled} />
            <span className="flex-1 truncate text-[12.5px] text-[var(--color-fg2)]">{m.label}</span>
            <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--color-fg3)]">{statusWords(s, m.enabled)}</span>
          </MenuItem>
        );
      })}
    </section>
  );
}
