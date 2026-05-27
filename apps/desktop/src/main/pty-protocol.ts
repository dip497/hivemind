/** NDJSON protocol shared by the PTY daemon and its client (main process).
 *  One JSON object per line; data strings carry escaped newlines so raw "\n"
 *  reliably delimits messages. */

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
  | { t: "list"; reqId: string }
  | { t: "ping"; reqId: string };

/** daemon → client */
export type ServerMsg =
  | { t: "attached"; reqId: string; id: string; pid: number; isNew: boolean; replay: string }
  | { t: "data"; id: string; data: string }
  | { t: "exit"; id: string; code: number; signal: number | null }
  | { t: "sessions"; reqId: string; ids: string[] }
  | { t: "pong"; reqId: string }
  | { t: "error"; reqId?: string; message: string };

export const SOCKET_NAME = "pty-daemon.sock";

export function frame(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Stateful NDJSON line splitter for a socket's incoming chunks. */
export function makeLineDecoder(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}
