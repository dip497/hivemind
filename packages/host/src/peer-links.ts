/**
 * Workspaces shared from here, served to peers (M1; design §4.3): a device the access lists admit
 * connects on `hive/ws/1` and names the workspace in its `sync` stream's first frame. When its
 * person may reach that workspace, the host keeps its replica in sync (`serveReplica`, which takes
 * its changes only when it may edit the board) and answers its calls on the `api` stream
 * (`servePeer`, as its role allows, about the workspace's own tiles); otherwise the connection
 * closes, "removed". The links served are kept here, so the host can say who is connected and
 * close a person's when it removes them or changes their role (design §4.2 E). The app and the
 * headless host each serve their own store's workspaces this way.
 */
import type { Link } from "@hivemind/workspace-host/hive-net";
import type { AccessLists } from "@hivemind/workspace-host/access";
import { parseSync, serveReplica, type Changes } from "@hivemind/workspace-host/doc-sync";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import { servePeer, type TextChannel } from "@hivemind/workspace-api/peers";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";

/** A link's named stream as a channel of text frames. */
export const streamOf = (link: Link, stream: string): TextChannel => ({
  send: (text) => link.send(stream, text),
  on: (listener) => link.on(stream, listener),
  closed: link.closed,
});

export interface PeerLinksOptions {
  /** The store whose workspaces are served. */
  store: WorkspaceStore;
  /** Each change the store makes. */
  changes: Changes;
  lists: AccessLists;
  server: WorkspaceServer;
  onWarn?(message: string): void;
}

interface Served { workspace: string; person: string; link: Link }

export class PeerLinks {
  private readonly served = new Set<Served>();

  constructor(private readonly o: PeerLinksOptions) {}

  /** Serve the device on `link` the workspace it names, if its person may reach it. */
  serve(link: Link): void {
    const { store, lists, server } = this.o;
    const off = link.on("sync", (text) => {
      const hello = parseSync(text);
      if (hello?.t !== "hello") return;
      off();
      const access = lists.accessOf(hello.workspace, link.peer);
      const person = lists.personOf(hello.workspace, link.peer);
      const repo = lists.repoOf(hello.workspace);
      if (!access || !person || !repo) return link.close("removed");
      const stop = serveReplica(store, repo, streamOf(link, "sync"), {
        seen: hello.seen,
        access,
        changes: this.o.changes,
        writer: `peer:${link.peer}`,
        onDropped: (why) => this.o.onWarn?.(`from ${link.peer.slice(0, 8)}…: ${why}`),
      });
      servePeer(server, streamOf(link, "api"), {
        actor: { kind: "peer", person, device: link.peer, access },
        workspace: hello.workspace,
        repo,
        // A terminal is named by its session (`hm:<tile>`), the document by the tile.
        holds: (tile) => store.workspaceOf(toBareId(tile)) === repo,
      });
      const entry: Served = { workspace: hello.workspace, person, link };
      this.served.add(entry);
      void link.closed.then(() => { this.served.delete(entry); stop(); });
    });
  }

  /** The people connected to `workspace` now. */
  connectedTo(workspace: string): Set<string> {
    return new Set([...this.served].filter((s) => s.workspace === workspace).map((s) => s.person));
  }

  /** Close each connection `person` has to `workspace`, telling them `reason`. */
  disconnect(workspace: string, person: string, reason: string): void {
    for (const s of this.served) if (s.workspace === workspace && s.person === person) s.link.close(reason);
  }
}
