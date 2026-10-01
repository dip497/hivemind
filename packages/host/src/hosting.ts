/**
 * Moving a workspace's hosting between the owner's devices (M3, design §5.7 B, F and §5.8,
 * spec/hosting.md). The device hosting a workspace hands another of the owner's devices the
 * workspace's document and its access list, on the `hosting` stream of a link to it (`take`); the
 * new host keeps them and answers; the old one records in the list where the workspace is now,
 * with a record signed by the workspace's key, and its links to the workspace are told so and
 * closed, which is the embedder's (`PeerLinks.moved`), and then hands over what changed while it
 * went (`catch-up`), answered once it is taken in: a connection closed the moment the other side
 * has the bytes can still lose them before they are read. One of the owner's devices may ask the device hosting a workspace to hand it
 * over to it (`move`): how a workspace comes back to the computer it was moved from. And while
 * the device hosting it is gone, one of the owner's devices may host it from the copy it kept
 * (`takeOver`, §5.7 E); the old host, back, finds the later record at the lookup server, and
 * hands over what it had (`yieldTo`).
 *
 * Frames on the old host stay there: before it goes, each folder on it names it
 * (`machine://<old host>/path`), so their terminals keep running in its daemon (step 3a); and the
 * new host keeps the workspace under the old host's folder for it, `machine://<old host>/<folder>`,
 * which is where a tile in no frame of its own runs, and what a client's `hive://<id>` reads as.
 * A device handed a workspace whose folder is its own keeps it there, and its frames' folders
 * named by its id are plainly its own again.
 */
import { machineUri, parseDeviceUri } from "@hivemind/core/remote-uri";
import type { AccessLists } from "@hivemind/workspace-host/access";
import type { Moved } from "@hivemind/workspace-host/doc-sync";
import type { FoundHost, Link } from "@hivemind/workspace-host/hive-net";
import type { WorkspaceStore } from "@hivemind/workspace-host/store";
import { ownershipIn } from "@hivemind/workspace-doc/schema";
import type { FrameRecord } from "@hivemind/workspace-doc/shapes";

/** What the `hosting` stream carries. */
export type HostingMessage =
  | { t: "take"; workspace: string; seq: number; record: string; root: string; doc: string; list: string }
  | { t: "catch-up"; workspace: string; doc: string }
  | { t: "move"; workspace: string };
export type HostingAnswer = { ok: true } | { ok: false; error: string };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));
const isHex = (v: unknown, bytes: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(v);
/** How long the device taking a workspace, or handing it over, has to answer. */
const TAKE_WAIT_MS = 30_000;

/** A folder of this device's (an absolute path; a remote one names its machine already), named so
 *  that it is still this device's from another one. */
const onDevice = (device: string, folder: string | undefined): string | undefined =>
  folder?.startsWith("/") ? machineUri(device, folder) : folder;
/** A folder named by this device's id, plainly its own again. */
const offDevice = (device: string, folder: string | undefined): string | undefined => {
  const at = folder ? parseDeviceUri(folder) : null;
  return at?.device === device ? at.path : folder;
};

export interface HostingOptions {
  /** This device's id. */
  self(): string;
  /** This device's person's id: whose workspaces it may take. */
  person(): string;
  store: WorkspaceStore;
  lists: AccessLists;
  /** Connect to one of the person's devices. */
  dial(device: string): Promise<Link>;
  /** The host record saying that `host` hosts `workspace`, the `seq`th to, signed by the
   *  workspace's key (spec/host-record.md). */
  sign(workspace: string, seq: number, host: string): Promise<string>;
  /** `workspace` is hosted elsewhere now: tell each device connected to it here `notice`, and
   *  close it. */
  moved(workspace: string, notice: Moved): void;
  /** A workspace was handed here, kept as `repo`: let in whom its list lets in, and say where it
   *  is now. */
  took(workspace: string, repo: string): void;
  onWarn?(message: string): void;
}

export class Hosting {
  constructor(private readonly o: HostingOptions) {}

  /**
   * Hand the workspace at `repo`, hosted here, to `device` (one of the owner's). The devices
   * connected to it are told where it went, and closed, before what changed meanwhile goes after
   * it. What they are told. A move the device refuses, or does not answer, leaves the workspace
   * here as it was.
   */
  async moveTo(repo: string, device: string): Promise<Moved> {
    const { store, lists } = this.o;
    const self = this.o.self();
    const workspace = store.ownership(repo)?.workspaceId;
    if (typeof workspace !== "string") throw new Error("this workspace does not say whose it is yet; change something in it first");
    const now = lists.hosting(workspace);
    if (now && now.host !== self) throw new Error("this workspace is hosted on another device now");
    if (device === self) throw new Error("this workspace is hosted here already");
    const seq = (now?.seq ?? 1) + 1;
    // Signed before anything changes: a move that cannot say where it went is not made.
    const record = await this.o.sign(workspace, seq, device);
    const link = await this.o.dial(device);
    try {
      // Its folders on this device stay this device's: their terminals keep running here.
      this.nameFolders(repo, (folder) => onDevice(self, folder));
      const sent = store.version(repo);
      const answer = await ask(link, { t: "take", workspace, seq, record, root: repo, doc: b64(store.exportSince(repo, null)), list: b64(lists.exportList(workspace)) })
        .catch((e: unknown): HostingAnswer => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      if (!answer.ok) {
        // Not taken: it stays here, its folders plainly this device's again.
        this.nameFolders(repo, (folder) => offDevice(self, folder));
        throw new Error(`${device.slice(0, 8)}… did not take it: ${answer.error}`);
      }
      lists.setHosting(workspace, device, seq, record);
      const notice: Moved = { t: "moved", host: device, seq, record };
      this.o.moved(workspace, notice);
      // Nothing changes it here from now on: what changed while it went goes after it.
      const since = store.exportSince(repo, sent);
      if (since.length > 0) {
        const caught = await ask(link, { t: "catch-up", workspace, doc: b64(since) }).catch((e: unknown): HostingAnswer => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        if (!caught.ok) this.o.onWarn?.(`what changed in ${workspace.slice(0, 8)}… while it moved did not go with it: ${caught.error}`);
      }
      return notice;
    } finally {
      // Closed behind what went on it.
      link.close("moved");
    }
  }

  /**
   * Host `workspace` here, at `repo` (its folder on this device), from `copy`, what this device kept
   * of it, while the device hosting it is gone (a take-over, §5.7 E): one move later than the last
   * this device knows of, as the record it then says at the lookup server says. The old host's own
   * folders are named by its id, where their terminals ran; this device's are plainly its own.
   */
  takeOver(workspace: string, repo: string, copy: Uint8Array): number {
    const { store, lists } = this.o;
    const self = this.o.self();
    const was = lists.hosting(workspace);
    if (!was || was.host === self) throw new Error("this workspace is hosted here already");
    const seq = was.seq + 1;
    store.adopt(repo, copy, { writer: `host:${was.host}` });
    this.nameFolders(repo, (folder) => offDevice(self, onDevice(was.host, folder)));
    lists.setHosting(workspace, self, seq);
    this.o.took(workspace, repo);
    return seq;
  }

  /**
   * `workspace`, hosted here as far as this device knew, is hosted by another device now, as
   * `found`, its record at the lookup server, says: taken over while this device was away. The
   * devices connected to it here are told where it is, and closed; what this device has of it,
   * its own folders named by its id, goes to the new host, which merges it; and from then on a
   * device that comes for it here is told where it is.
   */
  async yieldTo(workspace: string, found: FoundHost): Promise<void> {
    const { store, lists } = this.o;
    const repo = lists.repoOf(workspace) ?? store.repoOf(workspace);
    lists.setHosting(workspace, found.host, found.seq, found.record);
    this.o.moved(workspace, { t: "moved", host: found.host, seq: found.seq, record: found.record });
    if (!repo) return;
    this.nameFolders(repo, (folder) => onDevice(this.o.self(), folder));
    const link = await this.o.dial(found.host);
    try {
      const answer = await ask(link, { t: "catch-up", workspace, doc: b64(store.exportSince(repo, null)) });
      if (!answer.ok) throw new Error(`${found.host.slice(0, 8)}… did not take what this device had: ${answer.error}`);
    } finally {
      link.close("moved");
    }
  }

  /** Ask `host`, the device hosting `workspace`, to hand it over to this one: resolves once it is
   *  hosted here. */
  async moveHere(workspace: string, host: string): Promise<void> {
    const link = await this.o.dial(host);
    try {
      const answer = await ask(link, { t: "move", workspace });
      if (!answer.ok) throw new Error(`${host.slice(0, 8)}… did not hand it over: ${answer.error}`);
    } finally {
      link.close();
    }
  }

  /** What one of the owner's devices, `peer`, sends this one on the `hosting` stream: the answer. */
  async answer(peer: string, message: unknown): Promise<HostingAnswer> {
    const { store, lists } = this.o;
    if (!lists.ownersDevice(peer)) return { ok: false, error: "only the owner's devices hand a workspace over" };
    const m = message as Partial<HostingMessage> | null;
    if (m?.t === "catch-up") {
      const repo = isHex(m.workspace, 16) && typeof m.doc === "string" ? lists.repoOf(m.workspace) : null;
      if (!repo || lists.hosting(m.workspace!)?.host !== this.o.self()) return { ok: false, error: "that workspace is not hosted here" };
      store.importFrom(repo, fromB64(m.doc!), { writer: `host:${peer}` });
      return { ok: true };
    }
    if (m?.t === "move") {
      if (!isHex(m.workspace, 16)) return { ok: false, error: "malformed" };
      const repo = lists.repoOf(m.workspace) ?? store.repoOf(m.workspace);
      if (!repo) return { ok: false, error: "that workspace is not here" };
      return this.moveTo(repo, peer).then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    }
    return this.take(peer, m);
  }

  /** `peer` hands this device a workspace (`take`). */
  private take(peer: string, m: Partial<HostingMessage> | null): HostingAnswer {
    const { store, lists } = this.o;
    const self = this.o.self();
    const at = m?.t === "take" && typeof m.root === "string" ? parseDeviceUri(m.root) : null;
    if (m?.t !== "take" || !isHex(m.workspace, 16) || !Number.isSafeInteger(m.seq) || typeof m.record !== "string" || typeof m.root !== "string" || !(m.root.startsWith("/") || at) || typeof m.doc !== "string" || typeof m.list !== "string") {
      return { ok: false, error: "malformed" };
    }
    const known = lists.hosting(m.workspace);
    if (known && known.seq >= m.seq!) return { ok: false, error: "a later move of it is known here" };
    const doc = fromB64(m.doc);
    const own = ownershipIn(doc);
    if (own?.workspaceId !== m.workspace || own.owner !== this.o.person()) return { ok: false, error: "that is not a workspace of this device's person" };
    // Its folder on the device it comes from, as that device's; a folder of this device's is its own.
    const repo = at ? (at.device === self ? at.path : m.root) : machineUri(peer, m.root);
    store.adopt(repo, doc, { writer: `host:${peer}` });
    this.nameFolders(repo, (folder) => offDevice(self, folder));
    lists.adoptList(m.workspace, fromB64(m.list), repo);
    // With the record of the move, as the device it came from keeps it: the list is the same on
    // each of the owner's devices that keeps it in step with this one (`follow`).
    lists.setHosting(m.workspace, self, m.seq!, m.record);
    this.o.took(m.workspace, repo);
    return { ok: true };
  }

  /** The folders of each frame of the workspace at `repo`, as `name` names them. */
  private nameFolders(repo: string, name: (folder: string | undefined) => string | undefined): void {
    const { store } = this.o;
    const core = store.getCore(repo);
    if (!core) return;
    const frames = core.frames.map((f: FrameRecord) => ({ ...f, workspacePath: name(f.workspacePath), worktreePath: name(f.worktreePath) }));
    store.setCore(repo, { ...core, frames: frames.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined))) }, { writer: "sys:hosting", base: core });
  }

  /** What a device that comes for `workspace` is told, when it is hosted elsewhere now. */
  movedFrom(workspace: string): Moved | null {
    const h = this.o.lists.hosting(workspace);
    return h && h.host !== this.o.self() && h.record ? { t: "moved", host: h.host, seq: h.seq, record: h.record } : null;
  }
}

/** Send `message` on `link`'s `hosting` stream, and wait for the answer. */
function ask(link: Link, message: HostingMessage): Promise<HostingAnswer> {
  return new Promise((resolve, reject) => {
    const off = link.on("hosting", (text) => {
      let answer: HostingAnswer;
      try { answer = JSON.parse(text) as HostingAnswer; } catch { return; }
      if (typeof answer?.ok !== "boolean") return;
      clearTimeout(timer);
      off();
      resolve(answer);
    });
    const timer = setTimeout(() => { off(); reject(new Error("the device did not answer")); }, TAKE_WAIT_MS);
    void link.closed.then((why) => { clearTimeout(timer); off(); reject(new Error(`the device closed the connection: ${why}`)); });
    link.send("hosting", JSON.stringify(message));
  });
}
