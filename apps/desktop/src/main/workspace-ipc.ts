/**
 * The workspace API over Electron IPC (R8): each app window is a connection. Its calls come on
 * `workspace` and are answered; its notices come on `workspace:notice`; the host's events go to it
 * on `workspace:event`, from the moment it opens until it closes. Only the main frame of an app
 * window is heard (app-ipc.ts), and it is heard as the person at this machine.
 */
import type { WebContents } from "electron";
import type { Connection, WorkspaceServer } from "@hivemind/workspace-api/server";
import { PERSON, handle, on } from "./app-ipc.js";

export function serveWorkspaceApi(server: WorkspaceServer): { connect(window: WebContents): Connection } {
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
  handle("workspace", (e, method: unknown, params: unknown) => server.answer(method, params, connect(e.sender)));
  on("workspace:notice", (e, method: unknown, params: unknown) => server.notice(method, params, connect(e.sender)));
  return { connect };
}
