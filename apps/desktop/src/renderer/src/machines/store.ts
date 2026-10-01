/** Live machines + per-host connection state, pushed from main; one subscription for the whole renderer. */
import { useSyncExternalStore } from "react";
import type { MachineInfo, MachineStatus, MachinesSnapshot, PairedDeviceSummary } from "../../../shared/ipc";
import { isRemote, parseDeviceUri, parseMachineUri, parseRemote } from "@hivemind/core/remote-uri";

let snap: MachinesSnapshot = { machines: [], status: {} };
const listeners = new Set<() => void>();
let started = false;

function start(): void {
  if (started || !window.hive?.machinesGet) return;
  started = true;
  const tell = () => { for (const l of listeners) l(); };
  // Main's snapshot is the machines'; the person's devices come from Settings → Devices' list.
  const set = (s: MachinesSnapshot) => { snap = { ...s, ...(snap.devices ? { devices: snap.devices } : {}), ...(snap.self ? { self: snap.self } : {}) }; tell(); };
  const setDevices = (devices: PairedDeviceSummary[]) => { snap = { ...snap, devices }; tell(); };
  window.hive.onMachines(set);
  window.hive.machinesGet().then(set).catch(() => { /* main not ready: the push brings it */ });
  const devices = () => window.hive.devices?.().then(setDevices).catch(() => { /* none to list */ });
  window.hive.onDevicesChanged?.(() => void devices());
  void devices();
  void window.hive.identity?.().then((me) => { snap = { ...snap, self: me.deviceId }; tell(); }, () => { /* no keys yet */ });
}

/** This computer, where a frame on it is named by its id: in a workspace hosted elsewhere, the
 *  frames it moved away with (M3). */
const THIS_COMPUTER = "This computer";

function subscribe(l: () => void): () => void {
  start();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useMachines(): MachinesSnapshot {
  return useSyncExternalStore(subscribe, () => snap);
}

/** Where a remote folder is: its saved machine — the one it names (machine://), or one saved at
 *  its address (ssh://) — and the host its connection is kept by; or one of the person's devices
 *  (M3), its connection kept as `device:<id>`. No machine for a folder on one no longer saved, or
 *  on a host never saved; no host for a machine no longer saved, or a local folder. */
export interface Place { machine?: MachineInfo; device?: PairedDeviceSummary; hostId: string | null }
export function placeOf(s: MachinesSnapshot, uri: string | null | undefined): Place {
  if (!isRemote(uri)) return { hostId: null };
  const onDevice = parseDeviceUri(uri);
  if (onDevice) {
    const device = onDevice.device === s.self
      ? { device: onDevice.device, name: THIS_COMPUTER, kind: "app" as const, pairedAt: 0 }
      : s.devices?.find((d) => d.device === onDevice.device);
    return { ...(device ? { device } : {}), hostId: `device:${onDevice.device}` };
  }
  const at = parseMachineUri(uri);
  if (at) {
    const machine = s.machines.find((m) => m.id === at.machineId);
    return machine ? { machine, hostId: machine.hostId } : { hostId: null };
  }
  let hostId: string;
  try { hostId = parseRemote(uri).hostId; } catch { return { hostId: null }; }
  const machine = s.machines.find((m) => m.hostId === hostId);
  return machine ? { machine, hostId } : { hostId };
}

const IDLE: MachineStatus = { state: "idle", at: 0 };
export function statusOf(s: MachinesSnapshot, hostId: string | null): MachineStatus {
  return (hostId && s.status[hostId]) || IDLE;
}

/** What a machine no longer saved is called where a frame ran on it. */
export const GONE_MACHINE = "a machine no longer saved";
/** What a device no longer paired with this one is called where a frame runs on it. */
export const A_DEVICE = "a device not paired here";

/** The person whose computer a frame runs on when it is a participant's (M4), as a window knows
 *  them, and whether they are connected now. */
export interface MachineOwner { name: string; here: boolean }
/** What a participant's computer is called where a frame runs on it. */
export const whoseComputer = (o: MachineOwner): string => (o.name ? `${o.name}'s computer` : "someone's computer");
/** Whose computer the frame folder `uri` is on, when it is neither saved nor one of this person's
 *  devices, as `owners` knows them; null for any other. */
export function ownerOf(place: Place, uri: string | null | undefined, owners?: (device: string) => MachineOwner | null): MachineOwner | null {
  const at = !place.machine && !place.device && owners ? parseDeviceUri(uri ?? "") : null;
  return at ? owners!(at.device) : null;
}
/** How a participant's computer is doing, as far as this window can tell: connected, or not. */
export const ownerStatus = (o: MachineOwner): MachineStatus =>
  o.here ? { state: "online", at: 0 } : { state: "offline", detail: `${o.name || "Its person"} is not connected: what runs there shows here once they are`, at: 0 };

/** Where a frame runs, as every view sees it (the view protocol's `ViewFrame.machine`, 1.1): the
 *  saved machine's name — else the host itself, so a frame on a host never saved still says where
 *  it is — and the link's state. A local frame gets nothing. */
export function frameMachine(
  s: MachinesSnapshot,
  workspacePath: string | null | undefined,
  owners?: (device: string) => MachineOwner | null,
): { name: string; state: MachineStatus["state"]; rttMs?: number } | undefined {
  if (!isRemote(workspacePath)) return undefined;
  const place = placeOf(s, workspacePath);
  const owner = ownerOf(place, workspacePath, owners);
  if (owner) return { name: whoseComputer(owner), state: ownerStatus(owner).state };
  const { machine, device, hostId } = place;
  const st = statusOf(s, hostId);
  const name = machine?.label ?? device?.name ?? (hostId?.startsWith("device:") ? A_DEVICE : hostId?.replace(/:22$/, "")) ?? GONE_MACHINE;
  return { name, state: hostId ? st.state : "offline", ...(st.rttMs !== undefined ? { rttMs: st.rttMs } : {}) };
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
  /** Choose where a frame runs (null: a new frame); `machineId` jumps straight to that machine's folders. */
  | { kind: "pick"; frameId: string | null; machineId?: string };

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
