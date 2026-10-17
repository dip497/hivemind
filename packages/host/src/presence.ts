/**
 * Presence on a host (the workspace API's `presence.set`, `presence.changed`; M1): each client
 * says where it is in a workspace, and every client is told who is there: at once after a quiet
 * spell, and at most every 50 ms while people move (design §4.3), so five people's pointers are one
 * message to each client every 50 ms, not one per move. A window here is this machine's person; a
 * peer is theirs. Electron-free.
 */
import { text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain, WorkspaceServer } from "@hivemind/workspace-api/server";
import { PresenceHub, presenceOf } from "@hivemind/workspace-host/presence";

/** Everyone in a workspace is told who is there at most this often. */
export const PRESENCE_EVERY_MS = 50;

export function presence(server: () => WorkspaceServer, me: () => string): Domain<never, "presence.set"> {
  const hub = new PresenceHub();
  const ids = new WeakMap<Connection, string>();
  let made = 0;
  const idOf = (c: Connection): string => {
    let id = ids.get(c);
    if (!id) ids.set(c, (id = c.actor.kind === "peer" ? `peer:${c.actor.device}` : `window:${++made}`));
    return id;
  };
  const toldAt = new Map<string, number>();
  const due = new Map<string, ReturnType<typeof setTimeout>>();
  const publish = (repo: string): void => {
    toldAt.set(repo, Date.now());
    server().publish("presence.changed", repo, hub.people(repo));
  };
  /** `repo` changed: told now, or with whatever else changes, when it has been 50 ms. */
  const tell = (repo: string): void => {
    if (due.has(repo)) return;
    const wait = PRESENCE_EVERY_MS - (Date.now() - (toldAt.get(repo) ?? -Infinity));
    if (wait <= 0) return publish(repo);
    due.set(repo, setTimeout(() => { due.delete(repo); publish(repo); }, wait));
  };
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
