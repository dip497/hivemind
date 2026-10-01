/**
 * Terminals run by this machine's PTY daemon (the terminals' `SessionBackend` over a
 * `DaemonEndpoint`): each session lives in the daemon, so it outlives every client that shows it
 * and the host itself, and the host attaches to the ones it shows. Before a session starts, the
 * host's own checks: the folder is on this machine and is there, starts are paced (a client in a
 * loop cannot fork-bomb the machine), and an agent's first task rides its start rather than being
 * typed into it. The headless host runs its terminals this way.
 */
import fsp from "node:fs/promises";
import type { DaemonEndpoint } from "@hivemind/agent-host/daemon-endpoint";
import { INITIAL_PROMPT_ENV } from "@hivemind/agent-host/initial-prompt";
import { isRemote } from "@hivemind/core/remote-uri";
import type { SessionBackend } from "./terminals.js";

export interface DaemonSessionsOptions {
  endpoint: DaemonEndpoint;
  /** Resolves when another session may start; throws when too many wait. */
  pace(): Promise<void>;
}

export function daemonSessions({ endpoint, pace }: DaemonSessionsOptions): SessionBackend {
  return {
    start: async (opts, out) => {
      if (isRemote(opts.cwd)) throw new Error("this host runs terminals on its own machine only");
      // Showing an existing session starts no process, so it cannot fork-bomb anything.
      if (!opts.attachOnly) await pace();
      const st = await fsp.stat(opts.cwd).catch(() => null);
      if (!st?.isDirectory()) throw new Error(`pty cwd is not a directory: ${opts.cwd}`);
      const env = opts.initialPrompt ? { ...(opts.env ?? {}), [INITIAL_PROMPT_ENV]: opts.initialPrompt } : opts.env;
      const r = await endpoint.spawn(
        {
          tileId: opts.tileId, cwd: opts.cwd, cmd: opts.cmd, args: opts.args, cols: opts.cols, rows: opts.rows, env,
          noSpawn: opts.attachOnly, liveOnly: opts.attachOnly && opts.liveOnly,
        },
        { onData: (data, replay) => out.data(data, replay), onExit: (code, signal) => out.exit(code, signal) },
      );
      // Nothing to show: let go of it, so a later start is a start.
      if (r.pid === -1 && opts.attachOnly) endpoint.detach(opts.tileId);
      return r;
    },
    write: (tile, data, paste) => endpoint.write(tile, data, paste),
    echoes: () => true,
    resize: (tile, cols, rows) => endpoint.resize(tile, cols, rows),
    pause: (tile) => endpoint.pause(tile),
    resume: (tile) => endpoint.resume(tile),
    kill: (tile) => endpoint.kill(tile),
    detach: (tile) => endpoint.detach(tile),
    // Asked for when read: false once the daemon no longer holds the session.
    screen: (tile) => (endpoint.has(tile) ? (cb) => { if (!endpoint.has(tile)) return false; endpoint.screen(tile, cb); return true; } : null),
  };
}
