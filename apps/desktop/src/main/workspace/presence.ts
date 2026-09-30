/**
 * Presence on a host (the workspace API's `presence.set`, `presence.changed`; M1): each client
 * says where it is in a workspace, and every client is told who is there. A window here is this
 * machine's person; a peer is theirs. Electron-free.
 */
import { text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import { PresenceHub, presenceOf } from "@hivemind/workspace-host/presence";

export function presence(server: () => WorkspaceServer, me: () => string): Domain<never, "presence.set"> {
  const hub = new PresenceHub();
  const ids = new WeakMap<Connection, string>();
  let made = 0;
  const idOf = (c: Connection): string => {
    let id = ids.get(c);
    if (!id) ids.set(c, (id = c.actor.kind === "peer" ? `peer:${c.actor.device}` : `window:${++made}`));
    return id;
  };
  const tell = (repo: string): void => server().publish("presence.changed", repo, hub.people(repo));
  return {
    answers: {},
    effects: {},
    notices: {
      "presence.set": (from, repo, state) => {
        const r = text(repo, "repo");
        if (state === null) {
          if (hub.leave(idOf(from), r).length > 0) tell(r);
          return;
        }
        const s = presenceOf(state);
        if (!s) return;
        const person = from.actor.kind === "peer" ? from.actor.person : me();
        hub.set(r, { id: idOf(from), person, ...s });
        tell(r);
      },
    },
    gone: (connection) => {
      const id = ids.get(connection);
      if (id) for (const repo of hub.leave(id)) tell(repo);
    },
  };
}
