/**
 * The workspace API between devices (M1; spec/workspace-api.md, "Peers"): over a channel of text
 * frames (a `hive/ws/1` connection's `api` stream), a call is `{id, method, params}`, its answer
 * `{id, result}` or `{id, error}`, a notice has no `id`, and events are `{event, params}`. The
 * events of one moment go as one frame, a list of them: ten terminals' output is one frame, not
 * ten; and while events stream, a peer is sent a frame at most every 25 ms (M2's load gate), the
 * first after a quiet spell at once, so a keystroke's echo is not held. An answer goes after the
 * events before it.
 *
 * `servePeer` is the host's side: each call is checked against the peer's role (`roles.ts`) before
 * the host answers it, the workspace named by its id is read as its repo here, a tile outside the
 * workspace is refused, and the peer is sent only the events about the workspace's tiles.
 * `peerTransport` is the other side, a `ClientTransport` over the channel.
 */
import type { Actor } from "@hivemind/workspace-host/intents";
import type { ClientTransport } from "./client.js";
import { mayCall } from "./roles.js";
import type { Answer, EventMessage } from "./protocol.js";
import type { Links } from "./agents.js";
import type { Connection, WorkspaceServer } from "./server.js";

/** Text frames, both ways, until it closes. */
export interface TextChannel {
  send(text: string): void;
  on(listener: (text: string) => void): () => void;
  readonly closed: Promise<unknown>;
}

/** How a workspace is named to peers: by its id, never by where it is on the host. */
export const workspaceUrl = (workspaceId: string): string => `hive://${workspaceId}`;

export interface PeerOf {
  actor: Extract<Actor, { kind: "peer" }>;
  /** The workspace's id, and its repo here. */
  workspace: string;
  repo: string;
  /** Whether a tile is in the workspace. */
  holds(tile: string): boolean;
  /** What this peer may ask at all, whatever its role: a phone watches and types into the
   *  workspace's terminals and answers and messages its agents, and does nothing else there (M5).
   *  None: what its role allows. */
  allows?(method: string, params: unknown[]): boolean;
}

const refused = (message: string): Answer => ({ error: { code: "FORBIDDEN", message } });

/** Methods and notices whose first param names a tile. */
const BY_TILE = /^(terminal\.(write|show|resize|flow|close|detach|keyboard\.(ask|give|take))|plan\.decide|agent\.(answer|send|interrupt|close|diff))$/;
/** Methods and notices whose first param names the workspace, or a place in it (its `.hivemind`). */
const BY_WORKSPACE = /^(store|git|worktree|file|issue|review|people)\.|^(plan\.list|presence\.set|agent\.(startable|start))$/;

/** Whether `place`, as the host reads a param, is the workspace's repo `repo` or inside it: a
 *  peer names the workspace by its id, and nothing else on the host, no other folder and no other
 *  workspace or machine (`..` included). */
function inWorkspace(repo: string, place: string): boolean {
  if (place === repo) return true;
  if (place.split(/[\\/]/).includes("..")) return false;
  const sep = repo.endsWith("/") || repo.endsWith("\\") ? "" : "/";
  return place.startsWith(`${repo}${sep}`) || (sep !== "" && place.startsWith(`${repo}\\`));
}

/** The tiles an event concerns: it goes to a peer only when each is in its workspace. */
function tilesOf(event: EventMessage): string[] | null {
  const [p] = event.params as [Record<string, unknown> | string | undefined];
  switch (event.event) {
    case "terminal.data":
    case "terminal.exit":
    case "terminal.keyboard":
    case "terminal.keyboard.asked":
    case "terminal.size":
    case "terminal.typing":
      return [String(p)];
    case "status.changed":
      return [String((p as Record<string, unknown>)?.tileId)];
    case "link.pipe":
      return [String((p as Record<string, unknown>)?.src), String((p as Record<string, unknown>)?.dst)];
    case "link.spawn":
      return [String((p as Record<string, unknown>)?.parent), String((p as Record<string, unknown>)?.child)];
    case "tile.opened":
      return [String((p as Record<string, unknown>)?.id)];
    case "plan.review":
    case "plan.decided":
      return [String((p as Record<string, unknown>)?.tileId)];
    default:
      return null;
  }
}

/** While events stream to a peer, a frame at most this often. */
export const PEER_FRAME_MS = 25;

/** The peers with a frame waiting for the next tick of the one clock they all keep: a moment's
 *  frames to every peer go out together, in one write to the network daemon. */
const waiting = new Set<() => void>();
let ticking: ReturnType<typeof setTimeout> | null = null;
function atNextTick(flush: () => void): void {
  waiting.add(flush);
  ticking ??= setTimeout(() => {
    ticking = null;
    const due = [...waiting];
    waiting.clear();
    for (const f of due) f();
  }, PEER_FRAME_MS - (Date.now() % PEER_FRAME_MS));
}

/** Each event as JSON, once for however many peers it goes to. */
const encoded = new WeakMap<EventMessage, string>();
function json(event: EventMessage): string {
  let text = encoded.get(event);
  if (text === undefined) encoded.set(event, (text = JSON.stringify(event)));
  return text;
}

/** Serve the workspace API to a peer over `channel`, from `server`. */
export function servePeer(server: Pick<WorkspaceServer, "connect" | "answer" | "notice">, channel: TextChannel, peer: PeerOf): void {
  const url = workspaceUrl(peer.workspace);
  const inbound = (v: unknown): unknown => {
    if (v === url) return peer.repo;
    if (typeof v === "string" && v.startsWith(`${url}/`)) return peer.repo + v.slice(url.length);
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { cwd?: unknown }).cwd === "string") {
      return { ...(v as object), cwd: inbound((v as { cwd: string }).cwd) };
    }
    return v;
  };
  const outbound = (event: EventMessage): EventMessage | null => {
    if (event.event === "store.changed") return null; // the document reaches peers by its own sync
    if (event.event === "file.changed" || event.event === "presence.changed" || event.event === "people.asked" || event.event === "people.answered") {
      return event.params[0] === peer.repo ? { event: event.event, params: [url, ...event.params.slice(1)] } : null;
    }
    if (event.event === "terminal.activity") {
      const levels = Object.fromEntries(Object.entries((event.params[0] ?? {}) as Record<string, unknown>).filter(([tile]) => peer.holds(tile)));
      return { event: event.event, params: [levels] };
    }
    const tiles = tilesOf(event);
    if (tiles && !tiles.every((t) => peer.holds(t))) return null;
    return event;
  };
  const gone = new AbortController();
  let queued: EventMessage[] = [];
  let sentAt = -Infinity;
  let due = false;
  const flush = (): void => {
    due = false;
    if (queued.length === 0) return;
    sentAt = Date.now();
    const events = queued;
    queued = [];
    channel.send(events.length === 1 ? json(events[0]!) : `[${events.map(json).join(",")}]`);
  };
  const connection: Connection = {
    actor: peer.actor,
    send: (event) => {
      const out = outbound(event);
      if (!out) return;
      queued.push(out);
      if (due) return;
      due = true;
      // With whatever else this moment brings: at once after a quiet spell, else at the next tick.
      if (Date.now() - sentAt >= PEER_FRAME_MS) queueMicrotask(flush);
      else atNextTick(flush);
    },
    closed: gone.signal,
  };
  server.connect(connection);
  void channel.closed.then(() => gone.abort());

  const check = (method: unknown, params: unknown[]): string | null => {
    // Showing a terminal that is running already is watching it; starting one is not.
    const attaching = method === "terminal.open" && (params[0] as { attachOnly?: unknown } | null)?.attachOnly === true;
    if (peer.allows && !(typeof method === "string" && peer.allows(method, params))) return `${String(method)} is not open to this device`;
    if (attaching && !peer.holds(String((params[0] as { tileId?: unknown }).tileId))) return "that tile is not of this workspace";
    if (typeof method !== "string" || !(attaching || mayCall(peer.actor.access, method))) return `${String(method)} is not open to your role on this workspace`;
    if (BY_TILE.test(method) && !peer.holds(String(params[0]))) return `${String(params[0])} is not a tile of this workspace`;
    // A guest names this workspace, by its id, and nothing else on the host. The person's own
    // devices are the owner, there as here.
    if (BY_WORKSPACE.test(method) && peer.actor.access !== "owner" && params[0] != null && !(typeof params[0] === "string" && inWorkspace(peer.repo, params[0]))) {
      return "name this workspace by its id: nothing else of the host's is open to you";
    }
    if (method === "terminal.watchActivity" && Array.isArray(params[0]) && !params[0].every((t) => peer.holds(String(t)))) return "a tile there is not of this workspace";
    return null;
  };

  /** What the host answers of every agent it runs, narrowed to those of this workspace: a peer
   *  learns nothing of another workspace's agents, their statuses, titles or links. */
  const scoped = (method: unknown, answer: Answer): Answer => {
    if ("error" in answer) return answer;
    if (method === "status.all") return { result: (answer.result as Array<{ tileId: string }>).filter((s) => peer.holds(s.tileId)) };
    if (method !== "link.list") return answer;
    const { pipes, spawns } = answer.result as Links;
    return { result: { pipes: pipes.filter((p) => peer.holds(p.src) && peer.holds(p.dst)), spawns: spawns.filter((s) => peer.holds(s.parent) && peer.holds(s.child)) } };
  };

  channel.on((text) => {
    let m: { id?: unknown; method?: unknown; params?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    const params = Array.isArray(m.params) ? m.params.map(inbound) : [];
    const why = check(m.method, params);
    if (typeof m.id !== "number") {
      if (!why) server.notice(m.method, params, connection);
      return;
    }
    const id = m.id;
    void (why ? Promise.resolve(refused(why)) : server.answer(m.method, params, connection)).then((answer) => {
      flush();
      channel.send(JSON.stringify({ id, ...scoped(m.method, answer) }));
    });
  });
}

/** The workspace API of the host at the other end of `channel`. A call still waiting when the
 *  channel closes fails. */
export function peerTransport(channel: TextChannel): ClientTransport {
  let next = 1;
  const waiting = new Map<number, (answer: Answer) => void>();
  const listeners = new Set<(message: EventMessage) => void>();
  const take = (m: Record<string, unknown>): void => {
    if (typeof m.id === "number") {
      const done = waiting.get(m.id);
      waiting.delete(m.id);
      done?.("error" in m ? { error: m.error as { code: "FAILED"; message: string } } : { result: m.result });
    } else if (typeof m.event === "string" && Array.isArray(m.params)) {
      for (const l of listeners) l({ event: m.event, params: m.params });
    }
  };
  channel.on((text) => {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    // One moment's events come as a list.
    for (const one of Array.isArray(m) ? m : [m]) if (one && typeof one === "object") take(one as Record<string, unknown>);
  });
  let gone: string | null = null;
  const goneAnswer = (): Answer => ({ error: { code: "FAILED", message: `the host is gone (${gone})` } });
  void channel.closed.then((why) => {
    gone = String(why);
    for (const done of waiting.values()) done(goneAnswer());
    waiting.clear();
  });
  return {
    call: (method, params) => new Promise((resolve) => {
      if (gone !== null) return resolve(goneAnswer());
      const id = next++;
      waiting.set(id, resolve);
      channel.send(JSON.stringify({ id, method, params }));
    }),
    notice: (method, params) => channel.send(JSON.stringify({ method, params })),
    events: (listener) => { listeners.add(listener); },
  };
}
