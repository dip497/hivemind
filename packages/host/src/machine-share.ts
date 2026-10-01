/**
 * This machine, shown to the host of someone else's workspace (M4, design §5.4): the sessions its
 * person placed in frames of theirs on it, in that workspace, served from this machine's PTY daemon
 * over this machine's own connection to the host (the `machine` stream, which this machine opens:
 * the host never dials it), for everyone there to watch through the host.
 *
 * The host speaks the daemon's own protocol, through a filter that lets it watch those sessions and
 * nothing else. It may attach to one, which never starts it (nor restores one saved before a
 * reboot), sizes it or holds its output back; read its screen; and let go of it. It hears what the
 * daemon says of those sessions alone. Typing into a session, sizing, pausing and ending one, the
 * list of them, this machine's control plane and shutting its daemon down are this machine's
 * person's: dropped, or refused. A session the host asks for before it runs (its window opened the
 * tile as this machine's started it) is waited for a while.
 *
 * Unless this machine's person grants more (`Grant`, theirs to give and take back at any moment,
 * which the host is told on the stream): with `terminals`, what the host types into those
 * sessions reaches them (the host lends its keyboards as for its own), at the size they have here;
 * with `agents`, the host may also start, watch and end the session of a tile it put in a frame of
 * theirs here, in that workspace (the reverse journey: the host's agents work on this machine), in
 * that frame's folder, running what the workspace's document says. One it asks to start before
 * this machine's copy of the workspace holds its tile is waited for a while too.
 */
import type { Duplex } from "node:stream";
import { frame, makeLineDecoder, type ClientMsg, type ServerMsg } from "@hivemind/agent-host/pty-protocol";
import type { TextChannel } from "@hivemind/workspace-api/peers";

/** What opens the `machine` stream, and opens it again once this machine's daemon is back: what the
 *  host watched before is to be attached afresh. */
export const MACHINE_OFFER = `{"t":"machine"}`;

/** What the people in a workspace may do on this machine, as its person grants it: watch what they
 *  placed here; also type into it, as the workspace's host lends its keyboards; also run terminals
 *  and agents here. */
export type Grant = "watch" | "terminals" | "agents";
export const GRANTS: readonly Grant[] = ["watch", "terminals", "agents"];
/** Whether `grant` lets them do what `least` does. */
export const grants = (grant: Grant, least: Grant): boolean => GRANTS.indexOf(grant) >= GRANTS.indexOf(least);

/** The grant a line on the `machine` stream says, `{"t":"grant","grant"}`; null when it says none. */
export function grantOf(text: string): Grant | null {
  try {
    const m = JSON.parse(text) as { t?: unknown; grant?: unknown } | null;
    return m?.t === "grant" && GRANTS.includes(m.grant as Grant) ? (m.grant as Grant) : null;
  } catch {
    return null;
  }
}

/** How long a session the host asks to watch is waited for, while it does not run yet. */
export const SHOWN_WAIT_MS = 15_000;
const RETRY_MS = 300;
/** So many attaches wait at once at most: one more is refused. */
const WAITING_MAX = 64;

export interface MachineShareOptions {
  /** A new connection to this machine's PTY daemon, started if it is not running. */
  daemon(): Promise<Duplex>;
  /** Whether this machine shows the host the session `id`: one its person placed here, in the
   *  host's workspace. */
  shows(id: string): boolean;
  /** What the session `id` runs here when the host starts it, for a tile someone else put in a
   *  frame of this person's here, in the host's workspace: that frame's folder, and the program
   *  the workspace's document says. Null for any other (one this person placed is theirs to
   *  start). */
  runs(id: string): { cwd: string; cmd: string; args: string[] } | null;
  /** What its person lets the people in the host's workspace do here, now. */
  grant(): Grant;
  /** Hear each change of `grant`. */
  granted(listener: () => void): () => void;
  onWarn?(message: string): void;
}

type Fields = Record<string, unknown>;
const isText = (v: unknown): v is string => typeof v === "string";
/** A size the host gives, or `fallback`: a watcher's never sizes the session, but the daemon reads it. */
const sizeOr = (v: unknown, fallback: number): number => (Number.isInteger(v) && (v as number) > 0 && (v as number) < 10_000 ? (v as number) : fallback);
/** The environment the host gives a session it starts here, as text: a value that is not text is
 *  left out. */
const envOf = (v: unknown): { env?: Record<string, string> } => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return { env: Object.fromEntries(Object.entries(v as Fields).filter((e): e is [string, string] => isText(e[1]))) };
};
/** An attach the host asked for, while it waits. */
interface Asked {
  id: string;
  /** The host asks to start it if it does not run (it does not only watch it). */
  starts: boolean;
  size: { cols: number; rows: number };
  env: { env?: Record<string, string> };
  since: { since?: { seq: number; epoch: string } };
  until: number;
}
const position = (v: unknown): { seq: number; epoch: string } | null => {
  const p = v as Fields | null;
  return p && typeof p === "object" && Number.isInteger(p.seq) && isText(p.epoch) ? { seq: p.seq as number, epoch: p.epoch } : null;
};

/** Serve this machine's sessions to the host at the other end of `channel`, its `machine` stream,
 *  through the filter, until the function it returns is called. */
export function serveMachine(channel: Pick<TextChannel, "send" | "on">, o: MachineShareOptions): () => void {
  let daemon: Duplex | null = null;
  let opening: Promise<Duplex> | null = null;
  let stopped = false;
  /** What the host asked to be told of (its `hello`), told each connection to the daemon. */
  let caps: string[] = [];
  /** The sessions the host attached to here, or asked to. */
  const watched = new Set<string>();
  /** The attaches waiting for the daemon to be reached and their session to run (or to be held
   *  here, one the host starts), by the host's request: what it asked, until when. */
  const waiting = new Map<string, Asked>();

  const toHost = (msg: ServerMsg): void => channel.send(frame(msg));
  /** What this machine says on the stream besides the daemon's own lines, a line each as those
   *  are: the host reads the stream as the daemon's. */
  const say = (text: string): void => channel.send(`${text}\n`);
  /** What the session `id` runs here, when the host may start it: as granted. */
  const startable = (id: string) => (grants(o.grant(), "agents") ? o.runs(id) : null);
  const connect = (): Promise<Duplex> => {
    if (daemon) return Promise.resolve(daemon);
    return (opening ??= o.daemon().then((d) => {
      opening = null;
      if (stopped) { d.destroy(); throw new Error("no longer shown"); }
      daemon = d;
      d.on("data", makeLineDecoder(fromDaemon, () => d.destroy()));
      d.on("error", () => {});
      d.on("close", () => {
        if (daemon !== d) return;
        daemon = null;
        watched.clear();
        waiting.clear();
        // What the host watched went with it: shown afresh, it is attached again.
        if (!stopped) say(MACHINE_OFFER);
      });
      d.write(frame({ t: "hello", caps }));
      return d;
    }, (e: unknown) => { opening = null; throw e; }));
  };
  const toDaemon = (msg: ClientMsg, unreached?: () => void): void => {
    connect().then((d) => { d.write(frame(msg)); }, (e: unknown) => {
      if (stopped) return;
      o.onWarn?.(`this machine's terminals could not be reached: ${e instanceof Error ? e.message : String(e)}`);
      unreached?.();
    });
  };
  const refuse = (reqId: string, id: string, why: string): void => {
    waiting.delete(reqId);
    watched.delete(id);
    toHost({ t: "attached", reqId, id, pid: -1, isNew: false, replay: "", error: why });
  };
  /** The attach the daemon is asked for `asked` now: one that starts it, in its frame's folder
   *  running what the document says, when the host asks to and may; else one that only watches
   *  it, which never starts, restores, sizes or holds it back. Null while this machine shows the
   *  host no such session. */
  const attachOf = (reqId: string, asked: Asked): ClientMsg | null => {
    const run = startable(asked.id);
    if (!run && !o.shows(asked.id)) return null;
    const { id, size, since } = asked;
    return run && asked.starts
      ? { t: "attach", reqId, id, spec: { ...run, ...size, ...asked.env }, view: true, ...since }
      : { t: "attach", reqId, id, spec: { cwd: "", cmd: "", args: [], ...size }, noSpawn: true, liveOnly: true, view: true, ...since };
  };
  /** Ask the daemon for the attach `reqId` waits on. One the host starts may be on its way to this
   *  machine's copy of the workspace: waited for, as long as the host may start it. */
  const ask = (reqId: string): void => {
    const asked = waiting.get(reqId);
    if (!asked || stopped) return;
    if (!watched.has(asked.id)) return void waiting.delete(reqId);
    const attach = attachOf(reqId, asked);
    const why = "this machine does not show that session";
    if (!attach) return asked.starts && grants(o.grant(), "agents") ? again(reqId, why) : refuse(reqId, asked.id, why);
    toDaemon(attach, () => again(reqId, "this machine's terminals could not be reached"));
  };
  /** Not reached, or not running yet (its window here is starting it, or the daemon is coming
   *  back): asked again in a moment, a while; then refused, saying `why`. */
  const again = (reqId: string, why: string): void => {
    const asked = waiting.get(reqId);
    if (!asked || stopped) return;
    if (!watched.has(asked.id)) return void waiting.delete(reqId);
    if (Date.now() >= asked.until) return refuse(reqId, asked.id, why);
    setTimeout(() => ask(reqId), RETRY_MS).unref?.();
  };

  function fromHost(line: string): void {
    let m: Fields;
    try { m = JSON.parse(line) as Fields; } catch { return; }
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "hello":
        // Told when it falls behind, and what the daemon says of its sessions: nothing else.
        caps = (Array.isArray(m.caps) ? m.caps : []).filter((c): c is string => c === "resync" || c === "events");
        daemon?.write(frame({ t: "hello", caps }));
        return;
      case "attach": {
        if (!isText(m.reqId) || !isText(m.id)) return;
        if (waiting.size >= WAITING_MAX) return refuse(m.reqId, m.id, "this machine is asked for too much at once");
        const spec = (m.spec ?? {}) as Fields;
        const since = position(m.since);
        watched.add(m.id);
        waiting.set(m.reqId, {
          id: m.id,
          starts: m.noSpawn !== true,
          size: { cols: sizeOr(spec.cols, 80), rows: sizeOr(spec.rows, 24) },
          env: envOf(spec.env),
          since: since ? { since } : {},
          until: Date.now() + SHOWN_WAIT_MS,
        });
        return ask(m.reqId);
      }
      case "detach":
        if (isText(m.id) && watched.delete(m.id)) toDaemon({ t: "detach", id: m.id });
        return;
      case "screen": {
        if (!isText(m.reqId) || !isText(m.id)) return;
        const none = (): void => toHost({ t: "screen", reqId: m.reqId as string, id: m.id as string, replay: null });
        return watched.has(m.id) ? toDaemon({ t: "screen", reqId: m.reqId, id: m.id }, none) : none();
      }
      case "viewport": {
        if (!isText(m.reqId) || !isText(m.id)) return;
        const none = (): void => toHost({ t: "viewport", reqId: m.reqId as string, id: m.id as string, text: null });
        return watched.has(m.id) ? toDaemon({ t: "viewport", reqId: m.reqId, id: m.id }, none) : none();
      }
      case "write":
        // Typed by whoever the host lends the keyboard to, when this machine's person lets them.
        if (grants(o.grant(), "terminals") && isText(m.id) && watched.has(m.id) && isText(m.data)) {
          toDaemon({ t: "write", id: m.id, data: m.data, ...(m.paste === true ? { paste: true } : {}) });
        }
        return;
      case "kill":
        // Ended from the host only as granted.
        if (isText(m.id) && watched.has(m.id) && startable(m.id)) {
          watched.delete(m.id);
          toDaemon({ t: "kill", id: m.id });
        }
        return;
      case "ping":
        if (isText(m.reqId)) toDaemon({ t: "ping", reqId: m.reqId });
        return;
      case "list":
        if (isText(m.reqId)) toHost({ t: "error", reqId: m.reqId, message: "this machine's sessions are listed to its person alone" });
        return;
      case "control":
        if (isText(m.reqId)) toHost({ t: "control", reqId: m.reqId, error: "this machine's control plane is its own" });
        return;
      default:
        // Sizing, pausing, shutting the daemon down: its person's.
        return;
    }
  }

  function fromDaemon(line: string): void {
    let m: ServerMsg;
    try { m = JSON.parse(line) as ServerMsg; } catch { return; }
    const pass = (): void => channel.send(`${line}\n`);
    switch (m.t) {
      case "attached": {
        if (!waiting.has(m.reqId)) return;
        if (m.pid === -1) return again(m.reqId, m.error ?? "it does not run here");
        waiting.delete(m.reqId);
        // Let go of by the host meanwhile: let go of here too.
        if (!watched.has(m.id)) return toDaemon({ t: "detach", id: m.id });
        return pass();
      }
      case "data":
      case "resync":
      case "size":
        if (watched.has(m.id)) pass();
        return;
      case "exit":
        if (!watched.has(m.id)) return;
        // Nothing more of it is told, unless the host is yet to be told it attached: one that ends
        // as it starts is told it ended first.
        if (![...waiting.values()].some((a) => a.id === m.id)) watched.delete(m.id);
        return pass();
      case "screen":
      case "viewport":
        if (watched.has(m.id)) pass();
        return;
      case "event": {
        const tile = (m.data as { tileId?: unknown } | null)?.tileId;
        if (isText(tile) && (o.shows(tile) || startable(tile))) pass();
        return;
      }
      case "pong":
        return pass();
      default:
        return;
    }
  }

  const off = channel.on(makeLineDecoder(fromHost));
  const tellGrant = (): void => say(JSON.stringify({ t: "grant", grant: o.grant() }));
  say(MACHINE_OFFER);
  tellGrant();
  const offGrant = o.granted(tellGrant);
  return () => {
    stopped = true;
    off();
    offGrant();
    waiting.clear();
    watched.clear();
    daemon?.destroy();
    daemon = null;
  };
}
