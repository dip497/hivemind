/**
 * A workspace's document between its host and a replica (M1; design §4.3), over a channel of text
 * frames (a `hive/ws/1` connection's `sync` stream). The replica says what it has seen (`hello`);
 * the host answers with what it lacks (`welcome`), and from then on each side sends its changes as
 * they are made (`update`), from what the other has seen, so each sends only what the other
 * lacks. The host takes a replica's changes only when its access lets it edit the board: a
 * viewer's are dropped.
 */
import { ROLES, type Access } from "./access.js";
import type { WorkspaceChange, WorkspaceStore } from "./store.js";

/** Text frames, both ways. */
export interface SyncChannel {
  send(text: string): void;
  on(listener: (text: string) => void): () => void;
}

/** Hear each change a store makes. */
export type Changes = (listener: (change: WorkspaceChange) => void) => () => void;

export type SyncMessage =
  | { t: "hello"; workspace: string; seen: string | null }
  | { t: "welcome"; access: Access; data: string; seen: string }
  | { t: "update"; data: string };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

export function parseSync(text: string): SyncMessage | null {
  try {
    const m = JSON.parse(text) as Partial<SyncMessage> | null;
    if (m?.t === "hello" && typeof m.workspace === "string") return { t: "hello", workspace: m.workspace, seen: typeof m.seen === "string" ? m.seen : null };
    if (m?.t === "welcome" && typeof m.data === "string" && typeof m.seen === "string") return m as SyncMessage;
    if (m?.t === "update" && typeof m.data === "string") return m as SyncMessage;
    return null;
  } catch {
    return null;
  }
}

/** Whether `access` may change the board. */
export const mayEdit = (access: Access): boolean => access === "owner" || ROLES.indexOf(access) >= ROLES.indexOf("edit");

/**
 * The host's side for one replica of `repo`, which said it has seen `seen`: sends it what it lacks,
 * then each change the host's store makes, and takes the replica's changes as `writer`'s when
 * `access` may edit. Returns a function that stops it.
 */
export function serveReplica(
  store: WorkspaceStore,
  repo: string,
  channel: SyncChannel,
  opts: { seen: string | null; access: Access; changes: Changes; writer: string; onDropped?: (why: string) => void },
): () => void {
  let theirs: Uint8Array | null = opts.seen ? fromB64(opts.seen) : null;
  const lacking = (): string => {
    const data = store.exportSince(repo, theirs);
    theirs = store.version(repo);
    return b64(data);
  };
  const stopChanges = opts.changes((change) => {
    if (change.repo !== repo || (theirs && b64(theirs) === b64(store.version(repo)))) return;
    channel.send(JSON.stringify({ t: "update", data: lacking() }));
  });
  const stopFrames = channel.on((text) => {
    const m = parseSync(text);
    if (m?.t !== "update") return;
    if (!mayEdit(opts.access)) return opts.onDropped?.("a viewer's change");
    try {
      store.importFrom(repo, fromB64(m.data), { writer: opts.writer });
    } catch (e) {
      opts.onDropped?.(`a change that is not a document's (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  // Listening before the welcome goes: the replica answers it with what it wrote while away.
  const data = lacking();
  channel.send(JSON.stringify({ t: "welcome", access: opts.access, data, seen: b64(store.version(repo)) }));
  return () => { stopChanges(); stopFrames(); };
}

/**
 * The replica's side, for its copy `repo` of workspace `workspace`: says what it has seen, takes
 * the host's changes as the writer `host`, and sends each change made here. Returns a function
 * that stops it; `onWelcome` hears the access the host gave.
 */
export function replicate(
  store: WorkspaceStore,
  repo: string,
  channel: SyncChannel,
  opts: { workspace: string; changes: Changes; onWelcome?: (access: Access) => void; onFailed?: (why: string) => void },
): () => void {
  const HOST = "host";
  let hostHas = store.version(repo);
  const stopFrames = channel.on((text) => {
    const m = parseSync(text);
    if (m?.t !== "welcome" && m?.t !== "update") return;
    try {
      store.importFrom(repo, fromB64(m.data), { writer: HOST });
    } catch (e) {
      opts.onFailed?.(`the host's change could not be taken (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    if (m.t === "welcome") {
      // What was written here while away: the host has everything it sent, and lacks the rest.
      if (b64(store.version(repo)) !== m.seen) channel.send(JSON.stringify({ t: "update", data: b64(store.exportSince(repo, fromB64(m.seen))) }));
      opts.onWelcome?.(m.access);
    }
    hostHas = store.version(repo);
  });
  const stopChanges = opts.changes((change) => {
    if (change.repo !== repo || change.writer === HOST) return;
    const now = store.version(repo);
    if (b64(now) === b64(hostHas)) return;
    const data = store.exportSince(repo, hostHas);
    hostHas = now;
    channel.send(JSON.stringify({ t: "update", data: b64(data) }));
  });
  channel.send(JSON.stringify({ t: "hello", workspace: opts.workspace, seen: b64(hostHas) }));
  return () => { stopChanges(); stopFrames(); };
}
