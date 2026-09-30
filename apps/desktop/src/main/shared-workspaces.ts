/**
 * Workspaces shared with this person, open here (M1; design §4.2 B–C): each one's host dialled
 * over hive-net, its document kept in a replica (`sharedStore`, named `hive://<id>`) in sync, and
 * its host's workspace API for everything else a window asks about it. A window's call is routed
 * by what it names: the workspace (or a path in it), or a tile the replica holds.
 */
import type { Access } from "@hivemind/workspace-host/access";
import { replicate } from "@hivemind/workspace-host/doc-sync";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { peerTransport, workspaceUrl } from "@hivemind/workspace-api/peers";
import type { ClientTransport } from "@hivemind/workspace-api/client";
import type { Answer, EventMessage } from "@hivemind/workspace-api/protocol";
import type { Elsewhere } from "./workspace-ipc.js";
import { streamOf } from "./peers-host.js";
import { onWorkspaceChange, sharedStore } from "./workspace-store-ipc.js";

interface Open {
  link: Link;
  api: ClientTransport;
  /** The access the host gave, once it has welcomed this replica. */
  access: Access | null;
  stop(): void;
}

const open = new Map<string, Open>();

/** The workspace id a `hive://` name is of, or null. */
const idOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.startsWith("hive://")) return null;
  return v.slice("hive://".length).split("/")[0] || null;
};

/** Connect to the host of `workspace` (one joined here, at `host` and `where`), unless connected. */
export async function openShared(
  workspace: string,
  dial: () => Promise<Link>,
  publish: (event: EventMessage) => void,
): Promise<void> {
  if (open.has(workspace)) return;
  const link = await dial();
  const repo = workspaceUrl(workspace);
  const api = peerTransport(streamOf(link, "api"));
  api.events(publish);
  const entry: Open = { link, api, access: null, stop: () => {} };
  open.set(workspace, entry);
  entry.stop = replicate(sharedStore(), repo, streamOf(link, "sync"), {
    workspace,
    changes: onWorkspaceChange,
    onWelcome: (access) => { entry.access = access; },
    onFailed: (why) => console.warn(`[shared] ${workspace}: ${why}`),
  });
  void link.closed.then(() => {
    entry.stop();
    if (open.get(workspace) === entry) open.delete(workspace);
  });
}

/** The workspace a window's call is about, when it is one shared from elsewhere. */
function workspaceOf(method: unknown, params: unknown): string | null {
  if (typeof method !== "string" || !Array.isArray(params)) return null;
  const [first] = params as unknown[];
  const named = idOf(first) ?? idOf((first as { cwd?: unknown } | null)?.cwd);
  if (named) return named;
  // A tile's methods name the tile: it is shared from elsewhere when a replica holds it.
  if (typeof first === "string" || typeof (first as { tileId?: unknown } | null)?.tileId === "string") {
    const tile = typeof first === "string" ? first : (first as { tileId: string }).tileId;
    return idOf(sharedStore().workspaceOf(tile));
  }
  return null;
}

/** Routes a window's calls about a workspace shared from elsewhere to its host. The store's own
 *  methods stay here: the replica answers them. */
export const elsewhere: Elsewhere = {
  call(method, params): Promise<Answer> | null {
    if (typeof method === "string" && method.startsWith("store.")) return null;
    const ws = workspaceOf(method, params);
    if (!ws) return null;
    const entry = open.get(ws);
    if (!entry) return Promise.resolve({ error: { code: "FAILED", message: "not connected to this workspace's host" } });
    return entry.api.call(method as string, params as unknown[]);
  },
  notice(method, params): boolean {
    if (typeof method === "string" && method.startsWith("store.")) return false;
    const ws = workspaceOf(method, params);
    if (!ws) return false;
    open.get(ws)?.api.notice(method as string, params as unknown[]);
    return true;
  },
};

/** The access the host of `workspace` gave this person, while connected. */
export function sharedAccess(workspace: string): Access | null {
  return open.get(workspace)?.access ?? null;
}
