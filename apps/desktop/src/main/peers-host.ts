/**
 * A workspace shared from here, served to a peer (M1; design §4.3): a device the access lists
 * admit connects on `hive/ws/1` and names the workspace in its `sync` stream's first frame. When
 * its person may reach that workspace, the host keeps its replica in sync (`serveReplica`, which
 * takes its changes only when it may edit the board) and answers its calls on the `api` stream
 * (`servePeer`, as its role allows, about the workspace's own tiles); otherwise the connection
 * closes, "removed". The links served are kept here, so the host can say who is connected and
 * close a person's when it removes them or changes their role (design §4.2 E).
 */
import type { Link } from "@hivemind/workspace-host/hive-net";
import type { AccessLists } from "@hivemind/workspace-host/access";
import { parseSync, serveReplica } from "@hivemind/workspace-host/doc-sync";
import { servePeer, type TextChannel } from "@hivemind/workspace-api/peers";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import { onWorkspaceChange, workspaceStore } from "./workspace-store-ipc.js";

/** A link's named stream as a channel of text frames. */
export const streamOf = (link: Link, stream: string): TextChannel => ({
  send: (text) => link.send(stream, text),
  on: (listener) => link.on(stream, listener),
  closed: link.closed,
});

interface Served { workspace: string; person: string; link: Link }
const served = new Set<Served>();

/** The people connected to `workspace` now. */
export function connectedTo(workspace: string): Set<string> {
  return new Set([...served].filter((s) => s.workspace === workspace).map((s) => s.person));
}

/** Close each connection `person` has to `workspace`, telling them `reason`. */
export function disconnect(workspace: string, person: string, reason: string): void {
  for (const s of served) if (s.workspace === workspace && s.person === person) s.link.close(reason);
}

export function servePeerLink(link: Link, lists: AccessLists, server: WorkspaceServer): void {
  const off = link.on("sync", (text) => {
    const hello = parseSync(text);
    if (hello?.t !== "hello") return;
    off();
    const access = lists.accessOf(hello.workspace, link.peer);
    const person = lists.personOf(hello.workspace, link.peer);
    const repo = lists.repoOf(hello.workspace);
    if (!access || !person || !repo) return link.close("removed");
    const store = workspaceStore();
    const stop = serveReplica(store, repo, streamOf(link, "sync"), {
      seen: hello.seen,
      access,
      changes: onWorkspaceChange,
      writer: `peer:${link.peer}`,
      onDropped: (why) => console.warn(`[peers] from ${link.peer.slice(0, 8)}…: ${why}`),
    });
    servePeer(server, streamOf(link, "api"), {
      actor: { kind: "peer", person, device: link.peer, access },
      workspace: hello.workspace,
      repo,
      holds: (tile) => store.workspaceOf(tile) === repo,
    });
    const entry: Served = { workspace: hello.workspace, person, link };
    served.add(entry);
    void link.closed.then(() => { served.delete(entry); stop(); });
  });
}
