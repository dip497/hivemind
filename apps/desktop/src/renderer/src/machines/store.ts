/** Live machines + per-host connection state, pushed from main; one subscription for the whole renderer. */
import { useSyncExternalStore } from "react";
import type { MachineInfo, MachineStatus, MachinesSnapshot } from "../../../shared/ipc";
import { isRemote, parseRemote } from "../../../shared/remote-uri";

let snap: MachinesSnapshot = { machines: [], status: {} };
const listeners = new Set<() => void>();
let started = false;

function start(): void {
  if (started || !window.hive?.machinesGet) return;
  started = true;
  const set = (s: MachinesSnapshot) => { snap = s; for (const l of listeners) l(); };
  window.hive.onMachines(set);
  window.hive.machinesGet().then(set).catch(() => { /* main not ready: the push brings it */ });
}

function subscribe(l: () => void): () => void {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useMachines(): MachinesSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

export function hostIdOfUri(uri: string | null | undefined): string | null {
  if (!isRemote(uri)) return null;
  try { return parseRemote(uri).hostId; } catch { return null; }
}

export function machineByHost(s: MachinesSnapshot, hostId: string | null): MachineInfo | undefined {
  return hostId ? s.machines.find((m) => m.hostId === hostId) : undefined;
}

const IDLE: MachineStatus = { state: "idle", at: 0 };
export function statusOf(s: MachinesSnapshot, hostId: string | null): MachineStatus {
  return (hostId && s.status[hostId]) || IDLE;
}

/** An IPC rejection's own message, without Electron's wrapper. */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export type MachinesRequest =
  /** `machineId` opens that machine instead of the list — clicking a machine means that one. */
  | { kind: "manage"; machineId?: string }
  | { kind: "add"; target?: string }
  /** Choose where a frame runs; `machineId` jumps straight to that machine's folders. */
  | { kind: "pick"; frameId: string; machineId?: string };

/** Open the machines dialog from anywhere (frame header, Layers, a tile banner). */
export function openMachines(req: MachinesRequest): void {
  window.dispatchEvent(new CustomEvent<MachinesRequest>("hivemind:machines", { detail: req }));
}

/** The machine a request opens on, if it names one that is still there.
 *
 *  Clicking a machine — in the rail, or in the list — means "that machine", so both the
 *  pick flow and plain manage carry an id. A machine removed between the click and the
 *  dialog opening falls back to the list rather than an empty screen. */
export function machineForRequest(
  req: MachinesRequest | null,
  machines: readonly MachineInfo[],
): MachineInfo | undefined {
  const id = req && (req.kind === "pick" || req.kind === "manage") ? req.machineId : undefined;
  return id ? machines.find((m) => m.id === id) : undefined;
}
