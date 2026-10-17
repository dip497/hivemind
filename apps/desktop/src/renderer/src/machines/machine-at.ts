/**
 * A frame folder's machine as the window names it, and how it is doing: what the chip in a frame's
 * header and its panel both show.
 */
import { parseRemote, REMOTE_SCHEME } from "@hivemind/core/remote-uri";
import { useShown } from "../multiplayer/shown";
import { A_DEVICE, GONE_MACHINE, ownerOf, ownerStatus, placeOf, statusOf, useMachines, whoseComputer, type Place } from "./store";
import { useMachineOwners } from "./owners";

/** What a frame's machine is called: its saved name, or the device's (M3), else the host an ssh
 *  folder is on, else one no longer saved or paired. */
const nameOf = (uri: string, { machine, device, hostId }: Place) =>
  machine?.label ?? device?.name ?? (hostId?.startsWith("device:") ? A_DEVICE : hostId && uri.startsWith(REMOTE_SCHEME) ? parseRemote(uri).host : GONE_MACHINE);

/** The frame folder `uri`'s machine, its name and how it is doing: on a participant's computer
 *  (M4), theirs, connected or not; else as this machine's links say. */
export function useMachineAt(uri: string) {
  const snap = useMachines();
  const place = placeOf(snap, uri);
  const owner = ownerOf(place, uri, useMachineOwners(useShown().repo));
  return { snap, place, owner, name: owner ? whoseComputer(owner) : nameOf(uri, place), status: owner ? ownerStatus(owner) : statusOf(snap, place.hostId) };
}
