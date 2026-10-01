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
 *
 * A participant's app shows the sessions its person placed on their own machine, in frames of
 * theirs in a workspace here (M4), on the `machine` stream it opens to this host: the host watches
 * them through it, as `shownFrom` gives them, and never dials that machine. It says there what its
 * person lets the people here do on it (`Grant`), as they change it.
 *
 * One of the owner's phones (spec/pairing.md 0.3) is let in, as their device, for what a phone
 * does: it may ask on the `device` stream which workspaces there are and what waits on the person
 * in them (`needs`, spec/needs.md), and open one workspace's API on the `api` stream (its first
 * frame `{t:"open", workspace}`), as the owner, to watch its terminals and answer its agents
 * (`phoneMay`), and nothing of the rest (no terminals started or typed into, no workspace's board
 * or files, no hosting).
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
import { MACHINE_OFFER, grantOf, type Grant } from "./machine-share.js";
import { serveFiles } from "./device-files.js";
import { needsOf, type Need, type WaitingStatus } from "./needs.js";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import { linkDuplex } from "./device-sessions.js";

/** What a phone may ask of a workspace it opens (M5): to watch a terminal that runs there (its
 *  screen, then its output as it comes), and to answer what an agent there waits on the person
 *  for (`agent.answer`). Never to start or type into one. */
export const phoneMay = (method: string, params: unknown[]): boolean =>
  (method === "terminal.open" && (params[0] as { attachOnly?: unknown } | null)?.attachOnly === true) || method === "agent.answer";

/** The workspace a phone's `api` stream opens, as its first frame names it; null for anything else. */
function opened(text: string): string | null {
  try {
    const m = JSON.parse(text) as { t?: unknown; workspace?: unknown };
    return m.t === "open" && typeof m.workspace === "string" && /^[0-9a-f]{32}$/.test(m.workspace) ? m.workspace : null;
  } catch {
    return null;
  }
}

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
  /** A participant's machine `device` says it lets the people here do something else on it (M4). */
  granted?(device: string): void;
  /** Whether `device` is one of the owner's phones, which is served what a phone does alone. None:
   *  no phone pairs with this device. */
  phone?(device: string): boolean;
  /** Its agents' statuses, and the plans they wait on a person for: what the owner's devices are
   *  told waits on the person here. None: nothing does. */
  statuses?(): WaitingStatus[];
  plans?(): PlanReview[];
  onWarn?(message: string): void;
}

interface Served { workspace: string; person: string; link: Link; stop(): void }

/** A workspace a host holds, as it tells one of its owner's devices. */
export interface HeldWorkspace { workspace: string; name: string; repo: string }

/** What the `device` stream carries: a question (no list), and the host's answer: which workspaces
 *  it holds, or what waits on the person in them. */
export type DeviceMessage = { t: "workspaces"; workspaces?: HeldWorkspace[] } | { t: "needs"; needs?: Need[] };

function parseDevice(text: string): DeviceMessage | null {
  try {
    const m = JSON.parse(text) as { t?: unknown; workspaces?: unknown; needs?: unknown };
    // Asked what waits on the person; its answer is read by the person's phone (spec/needs.md).
    if (m.t === "needs" && m.needs === undefined) return { t: "needs" };
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
      if (m?.t !== "workspaces" || !m.workspaces) return;
      clearTimeout(timer);
      off();
      resolve(m.workspaces);
    });
    const timer = setTimeout(() => { off(); reject(new Error("the device did not say which workspaces it holds")); }, timeoutMs);
    void link.closed.then((why) => { clearTimeout(timer); off(); reject(new Error(`the device closed the connection: ${why}`)); });
    link.send("device", JSON.stringify({ t: "workspaces" } satisfies DeviceMessage));
  });
}

/** A participant's machine as this host shows what runs there (M4): the workspace a tile is in
 *  (`key`, the same for each tile of that workspace there), that machine's sessions, while its
 *  app shows them (`open`: null while it does not), and what its person lets the people here do
 *  on it now (watch, while it is not connected). */
export interface ShownMachine {
  key: string;
  open(): Duplex | null;
  grant(): Grant;
}

export class PeerLinks {
  private readonly served = new Set<Served>();
  /** The links whose app shows its machine's sessions here (M4), the workspace each is for, and
   *  what its person lets the people here do on it. */
  private readonly machines = new Map<Link, { workspace: string; grant: Grant }>();

  constructor(private readonly o: PeerLinksOptions) {}

  /** Serve the device on `link` the workspace it names, if its person may reach it. */
  serve(link: Link): void {
    const { store, lists, server, hosting } = this.o;
    // A phone runs nothing and holds nothing here: it is answered what it asks, and watches.
    if (this.o.phone?.(link.peer)) {
      link.on("device", (text) => this.answerDevice(link, text));
      const off = link.on("api", (text) => {
        off();
        const workspace = opened(text);
        const repo = workspace ? store.repoOf(workspace) : null;
        const person = workspace ? lists.personOf(workspace, link.peer) : null;
        if (!workspace || !repo || !person) return link.close("removed");
        servePeer(server, streamOf(link, "api"), {
          // The owner's device, held to what a phone does.
          actor: { kind: "peer", person, device: link.peer, access: "owner" },
          workspace,
          repo,
          holds: (tile) => store.workspaceOf(toBareId(tile)) === repo,
          allows: phoneMay,
        });
      });
      return;
    }
    this.bridgePty(link);
    // The files and git of frames on this machine, for the owner's other devices (M4).
    serveFiles(link, server, (device) => (lists.ownersDevice(device) ? lists.personOf("", device) : null));
    // Offered once the workspace is served (the app offers it once welcomed), for that workspace,
    // and what it grants, then as that changes.
    link.on("machine", (text) => {
      const shown = this.machines.get(link);
      const grant = grantOf(text);
      if (grant && shown && shown.grant !== grant) {
        shown.grant = grant;
        this.o.granted?.(link.peer);
      }
      const served = !shown && text.trim() === MACHINE_OFFER && [...this.served].find((s) => s.link === link);
      if (served) this.machines.set(link, { workspace: served.workspace, grant: "watch" });
    });
    link.on("hosting", (text) => {
      let message: unknown;
      try { message = JSON.parse(text); } catch { return; }
      const answered = hosting ? hosting.answer(link.peer, message) : Promise.resolve({ ok: false, error: "this device hosts nothing it is handed" });
      void answered.then((answer) => link.send("hosting", JSON.stringify(answer)));
    });
    link.on("device", (text) => this.answerDevice(link, text));
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
      void link.closed.then(() => { this.served.delete(entry); this.machines.delete(link); stop(); });
    });
  }

  /** Answer one of the owner's devices asking on the `device` stream which workspaces are here, or
   *  what waits on the person in them. */
  private answerDevice(link: Link, text: string): void {
    const { store, lists } = this.o;
    if (!lists.ownersDevice(link.peer)) return link.close("removed");
    const asked = parseDevice(text);
    if (asked?.t === "needs") {
      const boards = this.held().map(({ workspace, name, repo }) => ({ workspace, name, core: store.getCore(repo) }));
      const needs = needsOf(boards, this.o.statuses?.() ?? [], this.o.plans?.() ?? []);
      return link.send("device", JSON.stringify({ t: "needs", needs } satisfies DeviceMessage));
    }
    if (asked?.t !== "workspaces" || asked.workspaces) return;
    link.send("device", JSON.stringify({ t: "workspaces", workspaces: this.held() } satisfies DeviceMessage));
  }

  /** The workspaces this device holds. */
  private held(): HeldWorkspace[] {
    const { store } = this.o;
    return store.repos().flatMap((repo) => {
      const workspace = store.ownership(repo)?.workspaceId;
      return workspace ? [{ workspace, name: path.basename(repo), repo }] : [];
    });
  }

  /** The sessions on the participant's machine `device` (M4), for the workspace here that `tile`
   *  is in; null when no workspace here holds `tile`. */
  shownFrom(device: string, tile: string): ShownMachine | null {
    const repo = this.o.store.workspaceOf(toBareId(tile));
    const workspace = repo ? this.o.store.ownership(repo)?.workspaceId : null;
    if (typeof workspace !== "string") return null;
    return {
      key: `${device}/${workspace}`,
      open: () => {
        const link = this.machine(device, workspace);
        return link ? linkDuplex(link, "machine", { borrowed: true, endsAt: MACHINE_OFFER }) : null;
      },
      grant: () => {
        const link = this.machine(device, workspace);
        return (link && this.machines.get(link)?.grant) || "watch";
      },
    };
  }

  /** The connection of the app at `device` that shows its machine for `workspace`, if one does: its
   *  daemon's protocol, through the app's filter, is on that connection's `machine` stream, ended
   *  when the connection goes or the app shows it afresh (its daemon came back). */
  private machine(device: string, workspace: string): Link | null {
    return [...this.machines].find(([l, m]) => l.peer === device && m.workspace === workspace)?.[0] ?? null;
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
