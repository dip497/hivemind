/**
 * A workspace's access list between its host and the owner's other devices (M3; design §5.8), over
 * a channel of text frames (a `hive/ws/1` connection's `list` stream, served to the owner's devices
 * alone). The device that connected opens the stream, once the host has welcomed it as the
 * owner's (`doc-sync.ts`), by asking to follow the list; the host sends it then, and again each
 * time it changes. Each keeps it (`AccessLists.follow`), so whichever of them takes the workspace
 * over carries the list as it was: who was let in while it was hosted elsewhere, and who was taken
 * off.
 */
import type { AccessLists } from "./access.js";
import type { SyncChannel } from "./doc-sync.js";

/** One of the owner's devices asks to be sent the list of `workspace`. */
interface FollowMessage { t: "follow"; workspace: string }
/** The list of `workspace`, as the host has it now. */
interface ListMessage { t: "list"; workspace: string; data: string }

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A message on the stream, or null for anything else: what it says is checked where it is read. */
function parse(text: string): { t?: unknown; workspace?: unknown; data?: unknown } | null {
  try {
    const m = JSON.parse(text) as unknown;
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

/** The host's side: once the device asks, send `workspace`'s list, and again each time it changes.
 *  Returns a function that stops it. */
export function serveList(lists: Pick<AccessLists, "exportList" | "subscribe">, workspace: string, channel: Pick<SyncChannel, "send" | "on">): () => void {
  let unsubscribe: (() => void) | null = null;
  const off = channel.on((text) => {
    const m = parse(text);
    if (unsubscribe || m?.t !== "follow" || m.workspace !== workspace) return;
    const send = (): void => channel.send(JSON.stringify({ t: "list", workspace, data: b64(lists.exportList(workspace)) } satisfies ListMessage));
    unsubscribe = lists.subscribe((changed) => { if (changed === workspace) send(); });
    send();
  });
  return () => {
    off();
    unsubscribe?.();
  };
}

/** One of the owner's devices, welcomed as such: ask for `workspace`'s list, and keep it as its
 *  host sends it. Returns a function that stops it. */
export function followList(lists: Pick<AccessLists, "follow">, workspace: string, channel: Pick<SyncChannel, "send" | "on">, onFailed?: (why: string) => void): () => void {
  const off = channel.on((text) => {
    const m = parse(text);
    if (m?.t !== "list" || m.workspace !== workspace || typeof m.data !== "string") return;
    try {
      lists.follow(workspace, new Uint8Array(Buffer.from(m.data, "base64")));
    } catch (e) {
      onFailed?.(`a list that is not one (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  channel.send(JSON.stringify({ t: "follow", workspace } satisfies FollowMessage));
  return off;
}
