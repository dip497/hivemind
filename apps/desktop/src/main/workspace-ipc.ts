/**
 * The workspace API over Electron IPC (R8): each app window is a connection. Its calls come on
 * `workspace` and are answered; its notices come on `workspace:notice`; the host's events go to it
 * on `workspace:event`, from the moment it opens until it closes. Only the main frame of an app
 * window is heard (app-ipc.ts), and it is heard as the person at this machine.
 */
import type { WebContents } from "electron";
import type { Connection, WorkspaceServer } from "@hivemind/workspace-api/server";
import type { Answer } from "@hivemind/workspace-api/protocol";
import { PERSON, handle, on } from "./app-ipc.js";

/** Calls and notices another host answers: a workspace shared from elsewhere (M1). */
export interface Elsewhere {
  /** The answer from the host of the workspace the call names; null when it names none. */
  call(method: unknown, params: unknown): Promise<Answer> | null;
  /** Whether the notice went to such a host. */
  notice(method: unknown, params: unknown): boolean;
}

export function serveWorkspaceApi(server: WorkspaceServer, elsewhere?: Elsewhere): { connect(window: WebContents): Connection; find(window: WebContents): Connection | undefined } {
  const connections = new WeakMap<WebContents, Connection>();
  /** A window's connection: made the first time it is asked for, closed when the window goes. */
  const connect = (wc: WebContents): Connection => {
    const known = connections.get(wc);
    if (known) return known;
    const gone = new AbortController();
    const connection: Connection = {
      actor: PERSON,
      send: (message) => {
        if (wc.isDestroyed()) return;
        try { wc.send("workspace:event", message); } catch { /* torn down */ }
      },
      closed: gone.signal,
    };
    connections.set(wc, connection);
    wc.once("destroyed", () => gone.abort());
    server.connect(connection);
    return connection;
  };
  handle("workspace", (e, method: unknown, params: unknown) => {
    const conn = connect(e.sender);
    return elsewhere?.call(method, params) ?? server.answer(method, params, conn);
  });
  on("workspace:notice", (e, method: unknown, params: unknown) => {
    const conn = connect(e.sender);
    if (!elsewhere?.notice(method, params)) server.notice(method, params, conn);
  });
  return { connect, find: (wc) => connections.get(wc) };
}
