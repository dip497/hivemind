/** Where a remote folder is, to reach it (R9): Electron-free, so git and files can ask too. */
import { parseDeviceUri, parseMachineUri, parseRemote, sshUri, type RemoteTarget } from "@hivemind/core/remote-uri";
import { machines } from "./catalog.js";

/** One on a saved machine (machine://) at the machine's saved address, an ssh uri as written.
 *  Throws for a machine that is no longer saved, and for one of the person's devices, which is
 *  reached over hive-net, not ssh. */
export function remoteTarget(uri: string): RemoteTarget {
  const at = parseMachineUri(uri);
  if (!at) return parseRemote(uri);
  if (parseDeviceUri(uri)) throw new Error("this folder is on one of your devices: its files and git are not reached from here yet");
  const m = machines.list.find((x) => x.id === at.machineId);
  if (!m) throw new Error("the machine this folder was on is no longer saved — choose where it runs from the frame");
  return parseRemote(sshUri(m.target, at.path));
}
