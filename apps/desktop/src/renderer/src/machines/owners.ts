/**
 * Whose computer a frame runs on when it is a participant's (M4, design §5.4 items 2 and 6): the
 * person whose device it is, as this window knows them, and whether they are connected now.
 * Presence says who is here (`useDevicesHere`); the workspace's list (`people.list`, which its
 * owner's windows are answered) names them while they are not. A guest's window knows only who is
 * here.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { SharedPerson } from "../../../shared/ipc";
import { useDevicesHere } from "../multiplayer/presence";
import type { MachineOwner } from "./store";

type Listed = Pick<SharedPerson, "name" | "devices">;
const NONE: Listed[] = [];
/** Each workspace's list as last heard, and who was here when it was asked for. */
const listed = new Map<string, Listed[]>();
const askedAt = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Ask for `repo`'s list, again as someone comes or goes (`here`). */
function ask(repo: string, here: string): void {
  if (askedAt.get(repo) === here) return;
  askedAt.set(repo, here);
  void window.hive.people(repo).then((rows) => {
    listed.set(repo, rows.map((r) => ({ name: r.name, devices: r.devices })));
    for (const l of listeners) l();
  }, () => { /* not this window's to know: who is here says enough */ });
}

/** Whose each device a frame of `repo` may run on is, as this window knows them: null for one it
 *  does not. */
export function useMachineOwners(repo: string | null): (device: string) => MachineOwner | null {
  const here = useDevicesHere(repo);
  const rows = useSyncExternalStore(subscribe, () => (repo ? listed.get(repo) ?? NONE : NONE));
  const comings = here.map((d) => d.device).join(" ");
  useEffect(() => { if (repo) ask(repo, comings); }, [repo, comings]);
  return useCallback((device: string): MachineOwner | null => {
    const row = rows.find((r) => r.devices.includes(device));
    const now = here.find((d) => d.device === device);
    if (now) return { name: now.name || row?.name || "", here: true };
    return row ? { name: row.name, here: false } : null;
  }, [here, rows]);
}
