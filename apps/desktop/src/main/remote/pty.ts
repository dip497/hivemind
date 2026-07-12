/**
 * Remote interactive PTYs over ssh2. Mirrors the local pty-host surface
 * (spawnPty/writePty/resizePty/killPty/detachPty keyed by tileId) so the
 * ptySpawn IPC handler can branch on an ssh:// cwd with no other changes — the
 * pty:data/pty:exit plumbing is transport-agnostic.
 *
 * Remote PTYs run IN-MAIN (not the persistence daemon): an SSH drop loses
 * remote shell state, so reattach is meaningless, and keeping them here lets the
 * one ssh connection pool be shared with remote fs + git. detach == kill.
 */
import type { Client, ClientChannel, PseudoTtyOptions } from "ssh2";
import { parseRemote } from "../../shared/remote-uri.js";
import { shq } from "../claude-resume.js";
import { remoteConns } from "./conn.js";

interface SpawnOpts {
  tileId: string;
  /** ssh:// uri whose path is the remote cwd. */
  cwd: string;
  cmd: string;
  args?: string[];
  cols: number;
  rows: number;
  env?: Record<string, string>;
  /** Initial task delivered as claude's positional argv (HIVE_INITIAL_PROMPT); consumed by the ptySpawn handler into env. */
  initialPrompt?: string;
}

interface Callbacks {
  onData: (data: string) => void;
  onExit: (code: number, signal: number | undefined) => void;
}

/** One ssh2 exec/pty channel exposing write/resize/kill, analogous to IPty. */
class RemotePty {
  constructor(private stream: ClientChannel) {}

  static spawn(
    conn: Client,
    o: { path: string; cmd: string; args: string[]; cols: number; rows: number; env?: Record<string, string> },
    cb: Callbacks,
  ): Promise<RemotePty> {
    const pty: PseudoTtyOptions = { term: "xterm-256color", cols: o.cols, rows: o.rows };
    // Login shell, cd into the remote dir, exec the target program in the pty.
    const argv = [o.cmd, ...o.args].map(shq).join(" ");
    const inner = `cd ${shq(o.path)} && exec ${argv}`;
    const command = `bash -lc ${shq(inner)}`;
    return new Promise((resolve, reject) => {
      conn.exec(command, { pty, env: o.env }, (err, stream) => {
        if (err) return reject(err);
        stream.setEncoding("utf8");
        stream.on("data", (d: string) => cb.onData(d));
        stream.stderr?.on("data", (d: Buffer) => cb.onData(d.toString("utf8")));
        // 'close' is guaranteed (vs the optional 'exit') and carries the code.
        let done = false;
        stream.on("close", (code: number | null, signal?: string) => {
          if (done) return;
          done = true;
          cb.onExit(code ?? 0, signal ? 1 : undefined);
        });
        resolve(new RemotePty(stream));
      });
    });
  }

  write(data: string): void { this.stream.write(data); }
  resize(cols: number, rows: number): void {
    try { this.stream.setWindow(rows, cols, 0, 0); } catch { /* channel gone */ }
  }
  kill(): void {
    try { this.stream.signal("TERM"); } catch { try { this.stream.end(); } catch { /* gone */ } }
  }
}

const remotePtys = new Map<string, RemotePty>();
let remotePidSeq = 0;

/** Spawn a remote PTY for an ssh:// cwd. Returns a synthetic negative pid (the
 *  renderer uses pid only as an opaque liveness token). */
export async function spawnRemotePty(opts: SpawnOpts, cb: Callbacks): Promise<{ pid: number }> {
  if (remotePtys.has(opts.tileId)) killRemotePty(opts.tileId);
  const target = parseRemote(opts.cwd);
  const conn = await remoteConns.get(target);
  const p = await RemotePty.spawn(
    conn,
    { path: target.path, cmd: opts.cmd, args: opts.args ?? [], cols: opts.cols, rows: opts.rows, env: opts.env },
    {
      onData: cb.onData,
      onExit: (code, signal) => { remotePtys.delete(opts.tileId); cb.onExit(code, signal); },
    },
  );
  remotePtys.set(opts.tileId, p);
  return { pid: -(++remotePidSeq) };
}

export function writeRemotePty(tileId: string, data: string): void {
  remotePtys.get(tileId)?.write(data);
}
export function resizeRemotePty(tileId: string, cols: number, rows: number): void {
  remotePtys.get(tileId)?.resize(cols, rows);
}
export function killRemotePty(tileId: string): void {
  const p = remotePtys.get(tileId);
  if (p) { p.kill(); remotePtys.delete(tileId); }
}
export function hasRemotePty(tileId: string): boolean {
  return remotePtys.has(tileId);
}
