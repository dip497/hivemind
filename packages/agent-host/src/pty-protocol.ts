/** NDJSON protocol shared by the PTY daemon and its client (main process).
 *  One JSON object per line; data strings carry escaped newlines so raw "\n"
 *  reliably delimits messages. */
import { StringDecoder } from "node:string_decoder";

export interface SpawnSpecWire {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/** One row of `list {detail:true}`. */
export interface SessionInfo {
  id: string;
  /** frozen = restored from disk; respawns on attach */
  state: "live" | "frozen";
  cmd: string;
  args: string[];
  cwd: string;
  pid: number | null;
  viewers: number;
  cols: number;
  rows: number;
  title?: string;
}

// Append-only: new fields are optional and ignored by older peers.

/** client (desktop main, `hive attach`, `hive ps`) → daemon */
export type ClientMsg =
  /** noSpawn: a viewer must never create a session by guessing an id.
   *  liveOnly: with noSpawn, a running session only; a frozen one is not restored.
   *  since: resume from this output position (same epoch) instead of a full replay. */
  | { t: "attach"; reqId: string; id: string; spec: SpawnSpecWire; noSpawn?: boolean; liveOnly?: boolean; since?: { seq: number; epoch: string } }
  /** Capabilities of this client; "resync" = may be sent a fresh screen instead of every byte when behind. */
  | { t: "hello"; caps: string[] }
  | { t: "write"; id: string; data: string; /** A message pasted into the TUI, not keystrokes (see paste.ts). */ paste?: boolean }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "detach"; id: string }
  | { t: "kill"; id: string }
  /** Flow control (renderer back-pressure): stop reading the child's output
   *  until `resume` — the kernel pty buffer fills and the child blocks on write,
   *  so a `cat hugefile` can't outrun the renderer and balloon memory. */
  | { t: "pause"; id: string }
  | { t: "resume"; id: string }
  | { t: "list"; reqId: string; detail?: boolean }
  | { t: "ping"; reqId: string }
  /** The session's screen now, for a viewer about to show it again. */
  | { t: "screen"; reqId: string; id: string }
  /** The session's screen as text, line by line, as the daemon reads it: for a starter that skips
   *  a startup screen (agent-start.ts) with no terminal of its own. */
  | { t: "viewport"; reqId: string; id: string }
  /** This connection serves the machine's control plane (`hive host`), on the socket `sock`: while
   *  it lasts, the daemon passes each connection to the machine's control-plane socket on to `sock`,
   *  and still hears what agents report there, for its other viewers and its pushes. Answered by
   *  `control`. */
  | { t: "control"; reqId: string; sock: string }
  /** Ask the daemon to exit (used to replace a stale daemon after a rebuild). */
  | { t: "shutdown" };

/** daemon → client */
export type ServerMsg =
  /** delta: `replay` is only the output after the requested position, not a redraw. */
  | { t: "attached"; reqId: string; id: string; pid: number; isNew: boolean; replay: string; error?: string; seq?: number; epoch?: string; delta?: boolean }
  | { t: "data"; id: string; data: string; seq?: number }
  /** The viewer fell behind: its missed output was dropped; this is the screen now. */
  | { t: "resync"; id: string; replay: string; seq: number; epoch: string }
  /** An agent hook event from a daemon running without the desktop, to viewers that asked for "events". */
  | { t: "event"; topic: string; data: unknown }
  | { t: "exit"; id: string; code: number; signal: number | null }
  | { t: "sessions"; reqId: string; ids: string[]; detail?: SessionInfo[] }
  | { t: "pong"; reqId: string; buildStamp?: number }
  /** Answers `screen`, in order with the session's data: bytes before it are older than it. */
  | { t: "screen"; reqId: string; id: string; replay: string | null }
  /** Answers `control`; `error` when this daemon serves no control-plane socket (one the app
   *  started: the app serves it). */
  | { t: "control"; reqId: string; error?: string }
  /** Answers `viewport`; null when the session is not running. */
  | { t: "viewport"; reqId: string; id: string; text: string | null }
  | { t: "error"; reqId?: string; message: string };

export const SOCKET_NAME = "pty-daemon.sock";

/** Printed by `hive daemon bridge` once connected; anything before it is shell-profile noise. */
export const BRIDGE_READY = "HIVE-BRIDGE-READY\n";

export function frame(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Stateful NDJSON line splitter for a socket's incoming chunks.
 *  Scans with a moving offset and trims the consumed prefix ONCE per chunk —
 *  re-slicing the remainder after every line made a 64 KB chunk holding
 *  hundreds of small pty frames cost O(lines × bytes) copies (tens of MB of
 *  memmove per socket read during a streaming burst). */
/** A line longer than this is a peer that will never finish one; a remote machine is not trusted to behave. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

export function makeLineDecoder(onLine: (line: string) => void, onOverflow?: () => void): (chunk: Buffer | string) => void {
  let buf = "";
  // A socket read can split a multi-byte UTF-8 sequence across chunks; a plain
  // toString() would emit U+FFFD for both halves. StringDecoder holds the
  // partial bytes until the rest arrives.
  const utf8 = new StringDecoder("utf8");
  return (chunk) => {
    // What is already buffered holds no newline (it was scanned last time), so resume the
    // search where the new text begins — rescanning from 0 made a message that arrives in
    // k reads cost O(k·n).
    let from = buf.length;
    buf += typeof chunk === "string" ? chunk : utf8.write(chunk);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", from)) !== -1) {
      const line = buf.slice(start, nl);
      start = from = nl + 1;
      if (line.trim()) onLine(line);
    }
    buf = start === 0 ? buf : buf.slice(start);
    if (buf.length > MAX_LINE_CHARS) { buf = ""; onOverflow?.(); }
  };
}
