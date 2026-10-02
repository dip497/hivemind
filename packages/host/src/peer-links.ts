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
 * Any of the owner's devices, a phone among them, may follow every agent here on the `agents`
 * stream (spec/agents.md): it is sent the list now and again as it changes.
 *
 * The owner's other devices say on the `device` stream which phones paired with them, and ask to
 * forget one unpaired elsewhere (spec/pairing.md 0.7). One of the owner's phones (0.3) is let in,
 * as their device, for what a phone does: it may ask on the `device` stream which workspaces there
 * are and what waits on the person in them (`needs`, spec/needs.md), which of the owner's devices
 * it may reach through this one, give where it is told what happens there (`push`, spec/push.md)
 * and unpair itself (spec/pairing.md), and open one workspace's API on the `api`
 * stream (its first frame `{t:"open", workspace}`), as the owner, to watch and type into its
 * terminals, answer and message its agents and show its community views (`phoneMay`), and nothing
 * of the rest (no terminals started, sized or closed, no workspace's board or files, no hosting).
 */
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
import { heldBoards, needsOf, workingIn, type HeldBoard, type Need, type WaitingStatus } from "./needs.js";
import { agentsOf, type AgentFacts, type AgentItem } from "./agent-list.js";
import type { PlanReview } from "@hivemind/workspace-api/plans";
import type { KnownMachines } from "@hivemind/core/remote-uri";
import type { PairedWith } from "@hivemind/workspace-host/pairing";
import { subscriptionOf, type Subscription } from "./web-push.js";
import { linkDuplex } from "./device-sessions.js";

/** How long a phone that unpaired itself has to hang up before it is let go. */
const LET_GO_MS = 2_000;
/** The person's devices following the agents here are sent the list again at most this often: the
 *  first change at once, the changes in the next 100 ms together at its end (spec/agents.md). */
const FOLLOW_MS = 100;
/** What the workspace API tells its clients that changes the list of agents here. */
const LIST_EVENTS = new Set(["status.changed", "plan.review", "plan.decided"]);
const NO_FACTS: AgentFacts = { program: () => undefined, decides: () => false, interrupts: () => false };

/** What a phone may ask of a workspace it opens (M5): to watch a terminal that runs there (its
 *  screen, then its output as it comes) and type into it, asking for its keyboard while someone
 *  else holds it; to answer what an agent there waits on the person for (`agent.answer`), and to
 *  send one a message (`agent.send`); to start an agent, interrupt its turn, close it, see what it
 *  changed and follow what it says (spec/agents.md); and to show the community views here that work
 *  on a phone, which may do there what the phone may (P8, `views.ts`). Never to size a terminal, or
 *  to give or take a keyboard. */
const PHONE_MAY = new Set([
  "agent.answer", "agent.send", "terminal.write", "terminal.keyboard.ask",
  "agent.startable", "agent.start", "agent.interrupt", "agent.close", "agent.diff", "agent.conversation",
  "view.list", "view.file", "view.open", "view.post", "view.close",
]);
export const phoneMay = (method: string, params: unknown[]): boolean =>
  (method === "terminal.open" && (params[0] as { attachOnly?: unknown } | null)?.attachOnly === true) || PHONE_MAY.has(method);

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
  /** What this device's manifests say of the agent each tile of `held` runs: its program, whether
   *  a permission it asks can be allowed or denied from here (spec/needs.md 0.5), whether its turn
   *  can be interrupted (spec/agents.md). None: nothing. */
  facts?(held: HeldBoard[]): AgentFacts;
  /** The machines this device knows, by what each is called: where each agent waiting runs. */
  machines: KnownMachines;
  /** One of the owner's phones gives where it is told what happens here (its push subscription,
   *  spec/push.md). None: nobody is told. */
  subscribe?(device: string, sub: Subscription): void;
  /** One of the owner's phones unpairs itself: it is forgotten here (spec/pairing.md,
   *  "Unpairing"). None: no phone is kept here to forget. */
  unpair?(device: string): void;
  /** Another of the owner's devices, `by`, says which phones it paired with (`phones`, as it gives
   *  them): they are the owner's devices here too (spec/pairing.md 0.7). None: this device takes
   *  none. */
  introduced?(by: string, phones: unknown[]): void;
  /** Another of the owner's devices, `by`, unpaired the phone `device` that paired with this one:
   *  whether this one forgot it (spec/pairing.md 0.7). None: no phone pairs with this device. */
  forget?(by: string, device: string): boolean;
  /** The owner's devices a phone may reach through this one: those it paired with, phones aside.
   *  None: a phone is told of none. */
  devices?(): PairedWith[];
  /** Who the owner is to the people they work with (Settings → Profile): the name others see, and
   *  their colour (`#rrggbb`, or empty while none is chosen), which their phone shows as theirs
   *  (spec/pairing.md 0.8). None: a phone is told none. */
  profile?(): Promise<{ name: string; color: string }>;
  onWarn?(message: string): void;
}

interface Served { workspace: string; person: string; link: Link; stop(): void }

/** A workspace a host holds, as it tells one of its owner's devices. */
export interface HeldWorkspace { workspace: string; name: string; repo: string }

/** What the `device` stream carries: a question (no list), and the host's answer: which workspaces
 *  it holds, or what waits on the person in them and how many agents are at work there; where a
 *  phone is told what happens here, and whether it was taken; a phone unpairing itself; the phones
 *  another of the person's devices paired with, and whether they were taken; and the person's
 *  devices a phone may reach through this one. */
export type DeviceMessage =
  | { t: "workspaces"; workspaces?: HeldWorkspace[] }
  | { t: "needs"; needs?: Need[]; working?: number }
  | { t: "push"; sub: Subscription | null }
  | { t: "push"; ok: boolean; error?: string }
  | { t: "unpair"; ok?: boolean; error?: string }
  | { t: "phones"; phones: unknown[] }
  | { t: "phones"; ok: boolean; error?: string }
  | { t: "forget"; device: string }
  | { t: "forget"; ok: boolean }
  | { t: "devices"; devices?: PairedWith[]; profile?: { name: string; color: string } };

function parseDevice(text: string): DeviceMessage | null {
  try {
    const m = JSON.parse(text) as { t?: unknown; workspaces?: unknown; needs?: unknown; ok?: unknown; phones?: unknown; devices?: unknown; device?: unknown };
    // Asked what waits on the person; its answer is read by the person's phone (spec/needs.md).
    if (m.t === "needs" && m.needs === undefined) return { t: "needs" };
    // Given where to tell a phone what happens (spec/push.md).
    if (m.t === "push" && m.ok === undefined) return { t: "push", sub: subscriptionOf(m) };
    // A phone unpairing itself (spec/pairing.md).
    if (m.t === "unpair" && m.ok === undefined) return { t: "unpair" };
    // The phones another of the person's devices paired with, and whether they were taken
    // (spec/pairing.md 0.7).
    if (m.t === "phones") return m.ok === undefined ? { t: "phones", phones: Array.isArray(m.phones) ? m.phones : [] } : { t: "phones", ok: m.ok === true };
    // A phone another of the person's devices unpaired, for the one it paired with to forget.
    if (m.t === "forget") return m.ok === undefined ? (typeof m.device === "string" ? { t: "forget", device: m.device } : null) : { t: "forget", ok: m.ok === true };
    // A phone asking which of the person's devices it may reach through this one.
    if (m.t === "devices" && m.devices === undefined) return { t: "devices" };
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

/** Tell the device at the other end of `link`, another of the person's, which phones this one
 *  paired with (spec/pairing.md 0.7): all of them, so it forgets one listed no more. Whether it
 *  took them. */
export function tellPhones(link: Link, phones: PairedWith[], timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const off = link.on("device", (text) => {
      const m = parseDevice(text);
      if (m?.t !== "phones" || !("ok" in m)) return;
      clearTimeout(timer);
      off();
      resolve(m.ok);
    });
    const timer = setTimeout(() => { off(); reject(new Error("the device did not say whether it took the phones")); }, timeoutMs);
    void link.closed.then((why) => { clearTimeout(timer); off(); reject(new Error(`the device closed the connection: ${why}`)); });
    link.send("device", JSON.stringify({ t: "phones", phones } satisfies DeviceMessage));
  });
}

/** Ask the device at the other end of `link`, another of the person's, to forget the phone
 *  `device` it paired with: it was unpaired here (spec/pairing.md 0.7). Whether it did. */
export function askToForget(link: Link, device: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const off = link.on("device", (text) => {
      const m = parseDevice(text);
      if (m?.t !== "forget" || !("ok" in m)) return;
      clearTimeout(timer);
      off();
      resolve(m.ok);
    });
    const timer = setTimeout(() => { off(); reject(new Error("the device did not say whether it forgot the phone")); }, timeoutMs);
    void link.closed.then((why) => { clearTimeout(timer); off(); reject(new Error(`the device closed the connection: ${why}`)); });
    link.send("device", JSON.stringify({ t: "forget", device } satisfies DeviceMessage));
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
  /** The links of phones that unpaired themselves, forgotten once they are gone. */
  private readonly letGo = new WeakSet<Link>();
  /** The links whose app shows its machine's sessions here (M4), the workspace each is for, and
   *  what its person lets the people here do on it. */
  private readonly machines = new Map<Link, { workspace: string; grant: Grant }>();
  /** The owner's devices following every agent here (spec/agents.md), and the list each was last
   *  sent. */
  private readonly following = new Map<Link, string>();
  /** While the list went out within the last 100 ms: whether it changed since. */
  private held: { changed: boolean } | null = null;

  constructor(private readonly o: PeerLinksOptions) {
    // The list changes with the boards here, and with each status and plan the workspace API
    // tells its clients of: heard as one of them, which never calls.
    o.changes(() => this.agentsChanged());
    o.server.connect({ actor: { kind: "person" }, send: (e) => { if (LIST_EVENTS.has(e.event)) this.agentsChanged(); }, closed: new AbortController().signal });
  }

  /** Serve the device on `link` the workspace it names, if its person may reach it. */
  serve(link: Link): void {
    const { store, lists, server, hosting } = this.o;
    // A phone runs nothing and holds nothing here: it is answered what it asks, and watches.
    link.on("agents", (text) => this.follow(link, text));
    if (this.o.phone?.(link.peer)) {
      link.on("device", (text) => this.answerDevice(link, text, true));
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
    link.on("device", (text) => this.answerDevice(link, text, false));
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

  /** One of the owner's devices follows every agent here on the `agents` stream (spec/agents.md
   *  "Following"): sent the list now, and again as it changes, until it goes. */
  private follow(link: Link, text: string): void {
    if (!this.o.lists.ownersDevice(link.peer)) return link.close("removed");
    let asked: { t?: unknown } | null;
    try { asked = JSON.parse(text) as { t?: unknown } | null; } catch { return; }
    if (asked?.t !== "follow" || this.following.has(link)) return;
    const list = JSON.stringify(this.agentList());
    this.following.set(link, list);
    link.send("agents", list);
    void link.closed.then(() => this.following.delete(link));
  }

  /** The agents here changed: those following them are sent the list again, at once unless it went
   *  out within the last 100 ms, then at the end of that. */
  private agentsChanged(): void {
    if (this.following.size === 0) return;
    if (this.held) {
      this.held.changed = true;
      return;
    }
    const list = JSON.stringify(this.agentList());
    let sent = false;
    for (const [link, last] of this.following) {
      if (last === list) continue;
      this.following.set(link, list);
      link.send("agents", list);
      sent = true;
    }
    if (!sent) return;
    const held = (this.held = { changed: false });
    setTimeout(() => {
      this.held = null;
      if (held.changed) this.agentsChanged();
    }, FOLLOW_MS);
  }

  /** Every agent here, and how many are at work (spec/agents.md). */
  private agentList(): { t: "agents"; agents: AgentItem[]; working: number } {
    const held = heldBoards(this.o.store);
    const statuses = this.o.statuses?.() ?? [];
    const agents = agentsOf(held, statuses, this.o.plans?.() ?? [], this.o.machines, this.o.facts?.(held) ?? NO_FACTS);
    return { t: "agents", agents, working: workingIn(held, statuses) };
  }

  /** Answer one of the owner's devices asking on the `device` stream which workspaces are here, or
   *  what waits on the person in them; take where a phone, `phone`, is told what happens here; and
   *  let a phone unpair itself. */
  private answerDevice(link: Link, text: string, phone: boolean): void {
    const { store, lists } = this.o;
    if (!lists.ownersDevice(link.peer)) return link.close("removed");
    const asked = parseDevice(text);
    if (asked?.t === "needs") {
      const [held, statuses] = [heldBoards(store), this.o.statuses?.() ?? []];
      const facts = this.o.facts?.(held) ?? NO_FACTS;
      const needs = needsOf(held, statuses, this.o.plans?.() ?? [], this.o.machines, (tile) => facts.decides(tile));
      return link.send("device", JSON.stringify({ t: "needs", needs, working: workingIn(held, statuses) } satisfies DeviceMessage));
    }
    // Only a phone is told what happens here: a computer of the person's shows it.
    if (asked?.t === "push" && "sub" in asked && phone) {
      const taken = !!asked.sub && !!this.o.subscribe;
      if (taken) this.o.subscribe!(link.peer, asked.sub!);
      const answer: DeviceMessage = taken ? { t: "push", ok: true } : { t: "push", ok: false, error: asked.sub ? "this device tells nobody" : "not a push subscription" };
      return link.send("device", JSON.stringify(answer));
    }
    // A phone unpairing itself is told so, and forgotten once it hangs up, or is let go after a
    // moment: forgetting it cuts its connection at once, which would take the answer with it.
    if (asked?.t === "unpair" && phone) {
      if (!this.o.unpair) return link.send("device", JSON.stringify({ t: "unpair", ok: false, error: "this device keeps no phone" } satisfies DeviceMessage));
      if (this.letGo.has(link)) return;
      this.letGo.add(link);
      link.send("device", JSON.stringify({ t: "unpair", ok: true } satisfies DeviceMessage));
      const timer = setTimeout(() => link.close("removed"), LET_GO_MS);
      void link.closed.then(() => {
        clearTimeout(timer);
        this.o.unpair!(link.peer);
      });
    }
    // Another of the owner's devices says which phones it paired with: never a phone's word.
    if (asked?.t === "phones" && "phones" in asked && !phone) {
      if (!this.o.introduced) return link.send("device", JSON.stringify({ t: "phones", ok: false, error: "this device keeps no phone" } satisfies DeviceMessage));
      this.o.introduced(link.peer, asked.phones);
      return link.send("device", JSON.stringify({ t: "phones", ok: true } satisfies DeviceMessage));
    }
    // Another of the owner's devices unpaired a phone that paired with this one: never a phone's word.
    if (asked?.t === "forget" && "device" in asked && !phone) {
      return link.send("device", JSON.stringify({ t: "forget", ok: this.o.forget?.(link.peer, asked.device) ?? false } satisfies DeviceMessage));
    }
    // A phone asks which of the owner's devices it may reach through this one, and is told whose
    // they are.
    if (asked?.t === "devices" && phone) {
      const devices = this.o.devices?.() ?? [];
      void (this.o.profile?.() ?? Promise.resolve(undefined)).catch(() => undefined).then((profile) =>
        link.send("device", JSON.stringify({ t: "devices", devices, ...(profile ? { profile } : {}) } satisfies DeviceMessage)));
      return;
    }
    if (asked?.t !== "workspaces" || asked.workspaces) return;
    const workspaces = heldBoards(store).map(({ workspace, name, repo }) => ({ workspace, name, repo }));
    link.send("device", JSON.stringify({ t: "workspaces", workspaces } satisfies DeviceMessage));
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
