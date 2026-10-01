/**
 * Terminals in frames on another of the person's devices (M3, design §5.1): a frame whose folder
 * is `machine://<device id>/path` runs its terminals in that device's PTY daemon, reached over
 * hive-net on the `pty` stream of a link to it, which the device carries to its daemon for its
 * owner's devices (`PeerLinks`). One link and one daemon connection per device, made when a
 * session there is first started or shown and made again when it drops; each session is that
 * daemon's, so it outlives this host as it does the device's own windows.
 *
 * A frame on a participant's machine (M4) runs what its person placed there, on their machine:
 * nothing is started there from here, nor is it dialled. Its sessions are watched, from what its
 * app shows of them on its own connection here (`shown`), never sized or typed into from here.
 *
 * `onDevices` puts them beside the host's own: a session in a frame on another device goes there,
 * one on this device or any other machine goes where it went before.
 */
import { Duplex } from "node:stream";
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import { DaemonEndpoint, type EndpointState } from "@hivemind/agent-host/daemon-endpoint";
import { INITIAL_PROMPT_ENV } from "@hivemind/agent-host/initial-prompt";
import type { Link } from "@hivemind/workspace-host/hive-net";
import type { AccessLists } from "@hivemind/workspace-host/access";
import { toBareId } from "@hivemind/workspace-api/tile-id";
import type { TerminalOpts } from "@hivemind/workspace-api/terminals";
import type { SessionBackend, TerminalMachine } from "./terminals.js";
import type { ShownMachine } from "./peer-links.js";
import { SHOWN_WAIT_MS, grants } from "./machine-share.js";

export interface DeviceSessionsOptions {
  /** Connect to one of the person's devices. */
  dial(device: string): Promise<Link>;
  /** Whether `device` is one of the person's. A frame on anyone else's machine runs what its
   *  person placed there, on their machine (M4): nothing is started there from here, and no
   *  connection is made to it. */
  mine(device: string): boolean;
  /** What a participant's app shows of their machine `device` (M4), for the workspace `tile` is
   *  in: its sessions are watched through it. None: they are not shown here. */
  shown?(device: string, tile: string): ShownMachine | null;
  /** An event from a device's daemon about a session this host runs there (an agent's status). */
  onEvent?(topic: string, data: unknown): void;
  /** How the connection to a device is doing. */
  onStatus?(device: string, state: EndpointState, detail?: string): void;
}

export interface DeviceSessions extends SessionBackend {
  /** Whether the session `tile` runs on another device, from here. */
  holds(tile: string): boolean;
  /** Let go of every device's connection: their sessions keep running there. */
  close(): void;
}

/** This machine's control-plane credentials never go to another device. */
const ownEnvGone = (env?: Record<string, string>): Record<string, string> | undefined => {
  if (!env) return undefined;
  const { HCP_TOKEN: _t, HIVE_HCP_SOCK: _s, ...rest } = env;
  return rest;
};

/** `stream` on `link` as a duplex of text: what is written goes out in frames, what comes in is
 *  read; it ends with the link, or at the frame `endsAt`. Destroyed, it closes the link, unless it
 *  only borrows it (`borrowed`: the link carries more than this stream). */
export function linkDuplex(link: Link, stream: string, o: { borrowed?: boolean; endsAt?: string } = {}): Duplex {
  const d = new Duplex({
    read() {},
    write(chunk: Buffer | string, _encoding, done) {
      link.send(stream, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      done();
    },
    destroy(error, done) {
      off();
      if (!o.borrowed) link.close();
      done(error);
    },
  });
  const off = link.on(stream, (text) => (o.endsAt !== undefined && text.trim() === o.endsAt ? d.destroy() : void d.push(text)));
  void link.closed.then(() => { if (!d.destroyed) { d.push(null); d.destroy(); } });
  return d;
}

/** Why a device closes a link it will not serve: it is not one of the person's, or no longer. */
const TURNED_AWAY = /not admitted|removed/;

export function deviceSessions(o: DeviceSessionsOptions): DeviceSessions {
  const endpoints = new Map<string, DaemonEndpoint>();
  const tiles = new Map<string, DaemonEndpoint>();
  /** Starts waiting on each device, told if it turns this one away. */
  const waiting = new Map<string, Set<(why: string) => void>>();
  const letGo = (key: string): void => {
    const ep = endpoints.get(key);
    if (!ep) return;
    endpoints.delete(key);
    for (const [tile, at] of tiles) if (at === ep) tiles.delete(tile);
    ep.close();
  };
  /** The connection to the daemon `key` names (a device, or a participant's machine for one
   *  workspace), made by `connect`, the first time it is wanted. */
  const endpointFor = (key: string, device: string, connect: (made: DaemonEndpoint) => Promise<Duplex>, attachTimeoutMs?: number): DaemonEndpoint => {
    let ep = endpoints.get(key);
    if (!ep) {
      const made: DaemonEndpoint = new DaemonEndpoint({
        connect: () => connect(made),
        // Only what is about a session this host runs or watches there: the machine's own are its own.
        onEvent: (topic, data) => {
          const tile = (data as { tileId?: unknown } | null)?.tileId;
          if (typeof tile === "string" && tiles.get(tile) === made) o.onEvent?.(topic, data);
        },
        onStatus: (state, detail) => o.onStatus?.(device, state, detail),
        ...(attachTimeoutMs ? { attachTimeoutMs } : {}),
      });
      endpoints.set(key, (ep = made));
    }
    return ep;
  };
  /** One of the person's devices, dialled. */
  const deviceEndpoint = (device: string): DaemonEndpoint => endpointFor(device, device, async (made) => {
    const link = await o.dial(device);
    // Turned away: dialling again changes nothing until something is started there anew.
    void link.closed.then((why) => {
      if (!TURNED_AWAY.test(why) || endpoints.get(device) !== made) return;
      for (const tell of waiting.get(device) ?? []) tell(why);
      letGo(device);
    });
    return linkDuplex(link, "pty");
  });
  /** The machine `device` as it shows tile `tile` here (M4), once this host's copy of the tile's
   *  workspace holds it: one a window has just placed (`waits`) reaches it a moment after the
   *  window opens it, so it is waited for a while. */
  const shownOnceHeld = async (device: string, tile: string, waits: boolean): Promise<ShownMachine | null> => {
    for (const until = Date.now() + SHOWN_WAIT_MS; ; await new Promise((r) => setTimeout(r, 100))) {
      const shown = o.shown?.(device, tile) ?? null;
      if (shown || !waits || !o.shown || Date.now() >= until) return shown;
    }
  };
  /** A session in a frame on a participant's machine (M4): watched through what its app shows of
   *  it, never sized from here; it waits a while for one its window there is starting. One opened
   *  to be started (not only shown) is started there when they let the others run agents there:
   *  their machine decides. */
  const watch = async (opts: Parameters<SessionBackend["start"]>[0], out: Parameters<SessionBackend["start"]>[1], device: string): Promise<{ pid: number }> => {
    const shown = await shownOnceHeld(device, opts.tile ?? toBareId(opts.tileId), !opts.attachOnly);
    if (!shown) {
      if (opts.attachOnly) return { pid: -1 };
      throw new Error("this frame runs on someone else's machine: what runs there is theirs to start");
    }
    const ep = endpointFor(shown.key, device, async () => {
      const d = shown.open();
      if (!d) throw new Error("its machine is not connected");
      return d;
    }, SHOWN_WAIT_MS + 5_000);
    tiles.set(opts.tileId, ep);
    const env = opts.initialPrompt ? { ...(opts.env ?? {}), [INITIAL_PROMPT_ENV]: opts.initialPrompt } : opts.env;
    try {
      const r = await ep.spawn(
        { tileId: opts.tileId, cwd: "", cmd: opts.cmd, cols: opts.cols, rows: opts.rows, ...(opts.attachOnly ? { noSpawn: true, liveOnly: true } : { env: ownEnvGone(env) }) },
        {
          onData: (data, replay) => out.data(data, replay),
          onExit: (code, signal) => { tiles.delete(opts.tileId); out.exit(code, signal); },
          onSize: (cols, rows) => out.size?.(cols, rows),
        },
      );
      if (r.pid === -1) {
        ep.detach(opts.tileId);
        tiles.delete(opts.tileId);
        // Its machine answered: it does not run there. Otherwise, it was not reached.
        if (!ep.connected) throw new Error("this frame runs on someone else's machine, which is not connected: what runs there is shown here while it is");
      }
      return r;
    } catch (e) {
      tiles.delete(opts.tileId);
      throw e;
    }
  };
  const on = (tile: string) => tiles.get(tile);
  return {
    holds: (tile) => tiles.has(tile),
    start: async (opts, out) => {
      const at = parseDeviceUri(opts.cwd);
      if (!at) throw new Error(`${opts.cwd} is not a folder on one of your devices`);
      if (!o.mine(at.device)) return watch(opts, out, at.device);
      const ep = deviceEndpoint(at.device);
      tiles.set(opts.tileId, ep);
      const env = opts.initialPrompt ? { ...(opts.env ?? {}), [INITIAL_PROMPT_ENV]: opts.initialPrompt } : opts.env;
      let tell!: (why: string) => void;
      const turnedAway = new Promise<never>((_, reject) => {
        tell = (why) => reject(new Error(`the device ${at.device.slice(0, 8)}… does not run terminals for this one (${why})`));
      });
      const told = waiting.get(at.device) ?? new Set();
      waiting.set(at.device, told.add(tell));
      try {
        const r = await Promise.race([
          ep.spawn(
            {
              tileId: opts.tileId, cwd: at.path, cmd: opts.cmd, args: opts.args, cols: opts.cols, rows: opts.rows, env: ownEnvGone(env),
              noSpawn: opts.attachOnly, liveOnly: opts.attachOnly && opts.liveOnly,
            },
            { onData: (data, replay) => out.data(data, replay), onExit: (code, signal) => { tiles.delete(opts.tileId); out.exit(code, signal); } },
          ),
          turnedAway,
        ]);
        // Nothing to show: let go of it, so a later start is a start.
        if (r.pid === -1 && opts.attachOnly) { ep.detach(opts.tileId); tiles.delete(opts.tileId); }
        return r;
      } catch (e) {
        tiles.delete(opts.tileId);
        throw e;
      } finally {
        told.delete(tell);
      }
    },
    write: (tile, data, paste) => on(tile)?.write(tile, data, paste),
    // Its keystrokes echo from the other device.
    echoes: () => false,
    resize: (tile, cols, rows) => on(tile)?.resize(tile, cols, rows),
    pause: (tile) => on(tile)?.pause(tile),
    resume: (tile) => on(tile)?.resume(tile),
    kill: (tile) => { on(tile)?.kill(tile); tiles.delete(tile); },
    detach: (tile) => { on(tile)?.detach(tile); tiles.delete(tile); },
    screen: (tile) => {
      const ep = on(tile);
      return ep?.has(tile) ? (cb) => { if (!ep.has(tile)) return false; ep.screen(tile, cb); return true; } : null;
    },
    close: () => {
      for (const key of [...endpoints.keys()]) letGo(key);
    },
  };
}

/** Whose machine the session `opts` runs on, when its frame is on a participant's (M4): neither
 *  this device (`self`) nor one of the person's. The person whose device it is, as a workspace here
 *  lists them, and whether they lend its keyboard, as their machine says (`shown`). */
export function participantAt(opts: TerminalOpts, o: {
  self: string;
  mine(device: string): boolean;
  lists: Pick<AccessLists, "workspaces" | "personOf">;
  nameOf(person: string): string;
  shown(device: string, tile: string): ShownMachine | null;
}): TerminalMachine | null {
  const at = parseDeviceUri(opts.cwd);
  if (!at || at.device === o.self || o.mine(at.device)) return null;
  const person = o.lists.workspaces().map((ws) => o.lists.personOf(ws, at.device)).find((p): p is string => !!p) ?? "";
  // Found once this host's copy of its workspace holds the tile: a window opens one it has just
  // placed before then.
  let shown: ShownMachine | null = null;
  const lends = (): boolean => grants((shown ??= o.shown(at.device, opts.tile ?? toBareId(opts.tileId)))?.grant() ?? "watch", "terminals");
  return { who: { id: `peer:${at.device}`, person, name: person ? o.nameOf(person) : "" }, lends };
}

/**
 * The host's terminals wherever their frames are: a session in a frame on another of the person's
 * devices runs there (`devices`); one in a frame on this device, named by its id, runs here at its
 * path; any other, where `here` runs it (this machine, or a saved machine over ssh).
 */
export function onDevices(self: string, here: SessionBackend, devices: DeviceSessions): SessionBackend {
  const by = (tile: string): SessionBackend => (devices.holds(tile) ? devices : here);
  return {
    start: (opts, out) => {
      const at = parseDeviceUri(opts.cwd);
      if (!at) return here.start(opts, out);
      return at.device === self ? here.start({ ...opts, cwd: at.path }, out) : devices.start(opts, out);
    },
    write: (tile, data, paste) => by(tile).write(tile, data, paste),
    echoes: (tile) => by(tile).echoes(tile),
    resize: (tile, cols, rows) => by(tile).resize(tile, cols, rows),
    pause: (tile) => by(tile).pause(tile),
    resume: (tile) => by(tile).resume(tile),
    kill: (tile) => by(tile).kill(tile),
    detach: (tile) => by(tile).detach(tile),
    screen: (tile) => by(tile).screen(tile),
  };
}
