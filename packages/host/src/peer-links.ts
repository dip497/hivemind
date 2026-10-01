/**
 * Workspaces shared from here, served to peers (M1; design §4.3): a device the access lists admit
 * connects on `hive/ws/1` and names the workspace in its `sync` stream's first frame. When its
 * person may reach that workspace, the host keeps its replica in sync (`serveReplica`, which takes
 * its changes only when it may edit the board) and answers its calls on the `api` stream
 * (`servePeer`, as its role allows, about the workspace's own tiles); otherwise the connection
 * closes, "removed". The links served are kept here, so the host can say who is connected and
 * close a person's when it removes them or changes their role (design §4.2 E). The app and the
 * headless host each serve their own store's workspaces this way.
 *
 * One of the owner's own devices (paired, spec/pairing.md) is the owner of every workspace here,
 * shared or not, and may ask on the `device` stream which ones there are (design §5.3), run
 * terminals in this machine's PTY daemon on the `pty` stream, for frames it hosts on this machine
 * (M3, §5.1): the stream is the daemon's own protocol, carried to the daemon and back; and hand
 * this device a workspace to host, or ask for one hosted here, on the `hosting` stream (M3,
 * spec/hosting.md). A device that comes for a workspace hosted elsewhere now is told where
 * (`moved`), and closed.
 */
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import type { Link } from "@hivemind/workspace-host/hive-net";
import type { AccessLists } from "@hivemind/workspace-host/access";
import { parseSync, serveReplica, type Changes } from "@hivemind/workspace-host/doc-sync";
import { serveList } from "@hivemind/workspace-host/list-sync";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import { servePeer, type TextChannel } from "@hivemind/workspace-api/peers";
import type { WorkspaceServer } from "@hivemind/workspace-api/server";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { Moved } from "@hivemind/workspace-host/doc-sync";
import type { Hosting } from "./hosting.js";

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
  /** This machine's PTY daemon, for the owner's devices running terminals in frames here: a new
   *  connection to it, started if it is not running. None: nobody runs terminals here. */
  daemon?(): Promise<Duplex>;
  /** Where the workspaces here are hosted, and taking one another of the owner's devices hands
   *  over. None: this device takes none. */
  hosting?: Hosting;
  onWarn?(message: string): void;
}

interface Served { workspace: string; person: string; link: Link; stop(): void }

/** A workspace a host holds, as it tells one of its owner's devices. */
export interface HeldWorkspace { workspace: string; name: string; repo: string }

/** What the `device` stream carries: the question (no list), and the host's answer. */
export interface DeviceMessage { t: "workspaces"; workspaces?: HeldWorkspace[] }

function parseDevice(text: string): DeviceMessage | null {
  try {
    const m = JSON.parse(text) as { t?: unknown; workspaces?: unknown };
    if (m.t !== "workspaces") return null;
    if (!Array.isArray(m.workspaces)) return { t: "workspaces" };
    const workspaces = m.workspaces.filter((w): w is HeldWorkspace => {
      const x = w as Partial<HeldWorkspace> | null;
      return !!x && typeof x.workspace === "string" && typeof x.name === "string" && typeof x.repo === "string";
    });
    return { t: "workspaces", workspaces };
  } catch {
    return null;
  }
}

/** Ask the host at the other end of `link` which workspaces it holds: this device is one of its
 *  owner's. */
export function heldWorkspaces(link: Link, timeoutMs = 10_000): Promise<HeldWorkspace[]> {
  return new Promise((resolve, reject) => {
    const off = link.on("device", (text) => {
      const m = parseDevice(text);
      if (!m?.workspaces) return;
      clearTimeout(timer);
      off();
      resolve(m.workspaces);
    });
    const timer = setTimeout(() => { off(); reject(new Error("the device did not say which workspaces it holds")); }, timeoutMs);
    void link.closed.then((why) => { clearTimeout(timer); off(); reject(new Error(`the device closed the connection: ${why}`)); });
    link.send("device", JSON.stringify({ t: "workspaces" } satisfies DeviceMessage));
  });
}

export class PeerLinks {
  private readonly served = new Set<Served>();

  constructor(private readonly o: PeerLinksOptions) {}

  /** Serve the device on `link` the workspace it names, if its person may reach it. */
  serve(link: Link): void {
    const { store, lists, server, hosting } = this.o;
    this.bridgePty(link);
    link.on("hosting", (text) => {
      let message: unknown;
      try { message = JSON.parse(text); } catch { return; }
      const answered = hosting ? hosting.answer(link.peer, message) : Promise.resolve({ ok: false, error: "this device hosts nothing it is handed" });
      void answered.then((answer) => link.send("hosting", JSON.stringify(answer)));
    });
    link.on("device", (text) => {
      if (!lists.ownersDevice(link.peer)) return link.close("removed");
      const asked = parseDevice(text);
      if (!asked || asked.workspaces) return;
      const workspaces = store.repos().flatMap((repo) => {
        const workspace = store.ownership(repo)?.workspaceId;
        return workspace ? [{ workspace, name: path.basename(repo), repo }] : [];
      });
      link.send("device", JSON.stringify({ t: "workspaces", workspaces } satisfies DeviceMessage));
    });
    const off = link.on("sync", (text) => {
      const hello = parseSync(text);
      if (hello?.t !== "hello") return;
      off();
      // Hosted elsewhere now: said where, as the workspace's key signed it.
      const moved = hosting?.movedFrom(hello.workspace);
      if (moved) {
        link.send("sync", JSON.stringify(moved));
        return link.close("moved");
      }
      const access = lists.accessOf(hello.workspace, link.peer);
      const person = lists.personOf(hello.workspace, link.peer);
      // A workspace shared by invite is named in its list; any of the owner's is in the store.
      const repo = lists.repoOf(hello.workspace) ?? store.repoOf(hello.workspace);
      if (!access || !person || !repo) return link.close("removed");
      const replica = serveReplica(store, repo, streamOf(link, "sync"), {
        seen: hello.seen,
        access,
        changes: this.o.changes,
        writer: `peer:${link.peer}`,
        // A frame of theirs on their own device is theirs to place (M4).
        device: link.peer,
        onDropped: (why) => this.o.onWarn?.(`from ${link.peer.slice(0, 8)}…: ${why}`),
      });
      // The owner's other devices keep its list in step, to take it over with as it is (M3).
      const list = access === "owner" ? serveList(lists, hello.workspace, streamOf(link, "list")) : () => {};
      const stop = () => { replica(); list(); };
      servePeer(server, streamOf(link, "api"), {
        actor: { kind: "peer", person, device: link.peer, access },
        workspace: hello.workspace,
        repo,
        // A terminal is named by its session (`hm:<tile>`), the document by the tile.
        holds: (tile) => store.workspaceOf(toBareId(tile)) === repo,
      });
      const entry: Served = { workspace: hello.workspace, person, link, stop };
      this.served.add(entry);
      void link.closed.then(() => { this.served.delete(entry); stop(); });
    });
  }

  /** Carry the `pty` stream an owner's device opens to this machine's PTY daemon, and the daemon's
   *  answers back, until either goes. Anyone else is closed out. */
  private bridgePty(link: Link): void {
    let daemon: Duplex | null = null;
    let opening = false;
    const early: string[] = [];
    link.on("pty", (text) => {
      if (!this.o.daemon || !this.o.lists.ownersDevice(link.peer)) return link.close("removed");
      if (daemon) return void daemon.write(text);
      early.push(text);
      if (opening) return;
      opening = true;
      this.o.daemon().then((d) => {
        daemon = d;
        // The daemon's bytes go on as text: one character split across two reads stays whole.
        const utf8 = new StringDecoder("utf8");
        d.on("data", (chunk: Buffer | string) => {
          const out = typeof chunk === "string" ? chunk : utf8.write(chunk);
          if (out) link.send("pty", out);
        });
        d.on("error", () => {});
        d.on("close", () => link.close("this machine's terminals went"));
        for (const t of early.splice(0)) d.write(t);
        void link.closed.then(() => d.destroy());
      }, (e: unknown) => {
        this.o.onWarn?.(`terminals for ${link.peer.slice(0, 8)}…: ${e instanceof Error ? e.message : String(e)}`);
        link.close("no terminals here");
      });
    });
  }

  /** The people connected to `workspace` now. */
  connectedTo(workspace: string): Set<string> {
    return new Set([...this.served].filter((s) => s.workspace === workspace).map((s) => s.person));
  }

  /** `workspace` is hosted elsewhere now: each device connected to it here is told `notice`, its
   *  changes taken no more, and its connection closed. */
  moved(workspace: string, notice: Moved): void {
    for (const s of [...this.served]) {
      if (s.workspace !== workspace) continue;
      s.stop();
      s.link.send("sync", JSON.stringify(notice));
      s.link.close("moved");
    }
  }

  /** Close each connection `person` has to `workspace`, telling them `reason`. */
  disconnect(workspace: string, person: string, reason: string): void {
    for (const s of this.served) if (s.workspace === workspace && s.person === person) s.link.close(reason);
  }
}
