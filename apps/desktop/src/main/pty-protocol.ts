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

/** client (main) → daemon */
export type ClientMsg =
  | { t: "attach"; reqId: string; id: string; spec: SpawnSpecWire }
  | { t: "write"; id: string; data: string }
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "detach"; id: string }
  | { t: "kill"; id: string }
  /** Flow control (renderer back-pressure): stop reading the child's output
   *  until `resume` — the kernel pty buffer fills and the child blocks on write,
   *  so a `cat hugefile` can't outrun the renderer and balloon memory. */
  | { t: "pause"; id: string }
  | { t: "resume"; id: string }
  | { t: "list"; reqId: string }
  | { t: "ping"; reqId: string }
  /** Ask the daemon to exit (used to replace a stale daemon after a rebuild). */
  | { t: "shutdown" };

/** daemon → client */
export type ServerMsg =
  | { t: "attached"; reqId: string; id: string; pid: number; isNew: boolean; replay: string }
  | { t: "data"; id: string; data: string }
  | { t: "exit"; id: string; code: number; signal: number | null }
  | { t: "sessions"; reqId: string; ids: string[] }
  | { t: "pong"; reqId: string; buildStamp?: number }
  | { t: "error"; reqId?: string; message: string };

export const SOCKET_NAME = "pty-daemon.sock";

export function frame(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Stateful NDJSON line splitter for a socket's incoming chunks.
 *  Scans with a moving offset and trims the consumed prefix ONCE per chunk —
 *  re-slicing the remainder after every line made a 64 KB chunk holding
 *  hundreds of small pty frames cost O(lines × bytes) copies (tens of MB of
 *  memmove per socket read during a streaming burst). */
export function makeLineDecoder(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  // A socket read can split a multi-byte UTF-8 sequence across chunks; a plain
  // toString() would emit U+FFFD for both halves. StringDecoder holds the
  // partial bytes until the rest arrives.
  const utf8 = new StringDecoder("utf8");
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : utf8.write(chunk);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", start)) !== -1) {
      const line = buf.slice(start, nl);
      start = nl + 1;
      if (line.trim()) onLine(line);
    }
    buf = start === 0 ? buf : buf.slice(start);
  };
}
