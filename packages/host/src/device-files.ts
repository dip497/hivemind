/**
 * The files and git of a frame on another of the person's devices (M4 step 4, design §5.5). The
 * device whose folder it is answers the workspace API's calls about its folders (`git.*`,
 * `worktree.*`, `file.*`, `issue.*`, `review.*`) on the `files` stream of a link from one of the
 * person's other devices, as their owner, and answers nobody else's (`serveFiles`). Where a
 * window's call names a folder there (`machine://<device>/path`), the app sends it to that device,
 * the folder read as its own path there, and answers with what the device says (`deviceFolders`).
 */
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import type { Link } from "@hivemind/workspace-host/hive-net";
import { peerTransport, servePeer, type TextChannel } from "@hivemind/workspace-api/peers";
import type { ClientTransport } from "@hivemind/workspace-api/client";
import type { Answer } from "@hivemind/workspace-api/protocol";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";

/** The calls about a folder: what a device answers about its own. */
const ABOUT_FOLDER = /^(git|worktree|file|issue|review)\./;
const FILES = "files";
const channelOf = (link: Link): TextChannel => ({ send: (text) => link.send(FILES, text), on: (l) => link.on(FILES, l), closed: link.closed });

/** Answer the `files` stream of `link` from `server`, its calls about folders alone, while `person`
 *  says the device at the other end is one of the person's (their person key); else close it. */
export function serveFiles(link: Link, server: WorkspaceServer, person: (device: string) => string | null): void {
  let serve: ((text: string) => void) | null = null;
  link.on(FILES, (text) => {
    const owner = person(link.peer);
    if (!owner) return link.close("removed");
    if (!serve) {
      const heard = new Set<(text: string) => void>();
      const folders: Pick<WorkspaceServer, "connect" | "answer" | "notice"> = {
        connect: (c) => server.connect(c),
        answer: (method, params, c) => (typeof method === "string" && ABOUT_FOLDER.test(method)
          ? server.answer(method, params, c)
          : Promise.resolve({ error: { code: "FORBIDDEN", message: "this stream answers about this device's folders alone" } })),
        notice: (method, params, c) => { if (typeof method === "string" && ABOUT_FOLDER.test(method)) server.notice(method, params, c); },
      };
      servePeer(folders, { send: (t) => link.send(FILES, t), on: (l) => { heard.add(l); return () => { heard.delete(l); }; }, closed: link.closed }, {
        actor: { kind: "peer", person: owner, device: link.peer, access: "owner" },
        workspace: "", repo: "", holds: () => false,
      });
      serve = (t) => { for (const l of heard) l(t); };
    }
    serve(text);
  });
}

/** A window's calls about folders on the person's other devices, sent there. */
export interface DeviceFolders {
  /** The answer from the device whose folder the call names; null when it names none. */
  call(method: unknown, params: unknown): Promise<Answer> | null;
  /** Whether the notice went to such a device. */
  notice(method: unknown, params: unknown): boolean;
}

/** Send a window's calls about a folder on one of the person's devices (`mine`) to that device,
 *  over the `files` stream of a link to it (`dial`), kept while it lasts. */
export function deviceFolders(o: { mine(device: string): boolean; dial(device: string): Promise<Link> }): DeviceFolders {
  const reached = new Map<string, Promise<ClientTransport>>();
  const transportOf = (device: string): Promise<ClientTransport> => {
    let made = reached.get(device);
    if (!made) {
      const dialled = o.dial(device).then((link) => {
        void link.closed.then(() => { if (reached.get(device) === dialled) reached.delete(device); });
        return peerTransport(channelOf(link));
      });
      dialled.catch(() => { if (reached.get(device) === dialled) reached.delete(device); });
      reached.set(device, (made = dialled));
    }
    return made;
  };
  /** The device a call is about, and its params as that device reads them: each folder there as
   *  its path. */
  const routed = (method: unknown, params: unknown): { device: string; params: unknown[] } | null => {
    if (typeof method !== "string" || !ABOUT_FOLDER.test(method) || !Array.isArray(params)) return null;
    const at = typeof params[0] === "string" ? parseDeviceUri(params[0]) : null;
    if (!at || !o.mine(at.device)) return null;
    return { device: at.device, params: params.map((p) => (typeof p === "string" && parseDeviceUri(p)?.device === at.device ? parseDeviceUri(p)!.path : p)) };
  };
  return {
    call(method, params) {
      const r = routed(method, params);
      if (!r) return null;
      return transportOf(r.device).then(
        (t) => t.call(method as string, r.params),
        (e: unknown): Answer => ({ error: { code: "FAILED", message: `that device is not reached: ${e instanceof Error ? e.message : String(e)}` } }),
      );
    },
    notice(method, params) {
      const r = routed(method, params);
      if (!r) return false;
      void transportOf(r.device).then((t) => t.notice(method as string, r.params), () => {});
      return true;
    },
  };
}
