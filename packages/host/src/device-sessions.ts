/**
 * Terminals in frames on another of the person's devices (M3, design §5.1): a frame whose folder
 * is `machine://<device id>/path` runs its terminals in that device's PTY daemon, reached over
 * hive-net on the `pty` stream of a link to it, which the device carries to its daemon for its
 * owner's devices (`PeerLinks`). One link and one daemon connection per device, made when a
 * session there is first started or shown and made again when it drops; each session is that
 * daemon's, so it outlives this host as it does the device's own windows.
 *
 * `onDevices` puts them beside the host's own: a session in a frame on another device goes there,
 * one on this device or any other machine goes where it went before.
 */
import { Duplex } from "node:stream";
import { parseDeviceUri } from "@hivemind/core/remote-uri";
import { DaemonEndpoint, type EndpointState } from "@hivemind/agent-host/daemon-endpoint";
import { INITIAL_PROMPT_ENV } from "@hivemind/agent-host/initial-prompt";
import type { Link } from "@hivemind/workspace-host/hive-net";
import type { SessionBackend } from "./terminals.js";

export interface DeviceSessionsOptions {
  /** Connect to one of the person's devices. */
  dial(device: string): Promise<Link>;
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
 *  read; it ends with the link. */
export function linkDuplex(link: Link, stream: string): Duplex {
  const d = new Duplex({
    read() {},
    write(chunk: Buffer | string, _encoding, done) {
      link.send(stream, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      done();
    },
    destroy(error, done) {
      link.close();
      done(error);
    },
  });
  const off = link.on(stream, (text) => d.push(text));
  void link.closed.then(() => { off(); d.push(null); d.destroy(); });
  return d;
}

/** Why a device closes a link it will not serve: it is not one of the person's, or no longer. */
const TURNED_AWAY = /not admitted|removed/;

export function deviceSessions(o: DeviceSessionsOptions): DeviceSessions {
  const endpoints = new Map<string, DaemonEndpoint>();
  const tiles = new Map<string, DaemonEndpoint>();
  /** Starts waiting on each device, told if it turns this one away. */
  const waiting = new Map<string, Set<(why: string) => void>>();
  const letGo = (device: string): void => {
    const ep = endpoints.get(device);
    if (!ep) return;
    endpoints.delete(device);
    for (const [tile, at] of tiles) if (at === ep) tiles.delete(tile);
    ep.close();
  };
  const endpointFor = (device: string): DaemonEndpoint => {
    let ep = endpoints.get(device);
    if (!ep) {
      const made: DaemonEndpoint = new DaemonEndpoint({
        connect: async () => {
          const link = await o.dial(device);
          // Turned away: dialling again changes nothing until something is started there anew.
          void link.closed.then((why) => {
            if (!TURNED_AWAY.test(why) || endpoints.get(device) !== made) return;
            for (const tell of waiting.get(device) ?? []) tell(why);
            letGo(device);
          });
          return linkDuplex(link, "pty");
        },
        // Only what is about a session this host runs there: the device's own are its own.
        onEvent: (topic, data) => {
          const tile = (data as { tileId?: unknown } | null)?.tileId;
          if (typeof tile === "string" && tiles.get(tile) === made) o.onEvent?.(topic, data);
        },
        onStatus: (state, detail) => o.onStatus?.(device, state, detail),
      });
      endpoints.set(device, (ep = made));
    }
    return ep;
  };
  const on = (tile: string) => tiles.get(tile);
  return {
    holds: (tile) => tiles.has(tile),
    start: async (opts, out) => {
      const at = parseDeviceUri(opts.cwd);
      if (!at) throw new Error(`${opts.cwd} is not a folder on one of your devices`);
      const ep = endpointFor(at.device);
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
      for (const device of [...endpoints.keys()]) letGo(device);
    },
  };
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
