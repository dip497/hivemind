/**
 * Remote command execution over an ssh2 Client `exec` channel, plus a safe
 * git-command builder. Local git shells out via spawn(argv) (no shell, no
 * injection); over SSH `exec` runs a SHELL STRING, so every interpolated path/
 * arg MUST be POSIX-escaped with shq() (reused from claude-resume).
 */
import type { Client } from "ssh2";
import { shq } from "../claude-resume.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Exit code, or null if the channel closed on a signal. */
  code: number | null;
}

/**
 * Run one command over ssh, capturing stdout/stderr/exit. No PTY (clean capture
 * for parsing). The SSH 'close' event is guaranteed (unlike the optional 'exit')
 * and carries the exit code, so completion binds to 'close'.
 */
export function execCapture(
  conn: Client,
  cmd: string,
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const out: Buffer[] = [];
      const errb: Buffer[] = [];
      const timer = setTimeout(() => {
        try { stream.signal("KILL"); } catch { stream.close(); }
        reject(new Error(`remote exec timed out (${timeoutMs}ms): ${cmd}`));
      }, timeoutMs);
      stream.on("data", (d: Buffer) => out.push(d));
      stream.stderr.on("data", (d: Buffer) => errb.push(d));
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(errb).toString("utf8"),
          code,
        });
      });
      stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

/**
 * Build a safe remote `git -C <path> <args…>` command string. Mirrors the
 * argv arrays the local adapter passes to spawn("git", args, {cwd}); each arg
 * is single-quote-escaped so paths/refs with spaces or metacharacters can't
 * break out of the remote shell.
 */
export function remoteGit(repoPath: string, args: string[]): string {
  return `git -C ${shq(repoPath)} ${args.map(shq).join(" ")}`;
}

/**
 * Tiny per-key concurrency limiter. OpenSSH caps simultaneous sessions
 * (MaxSessions, default 10); a burst of parallel git execs over one connection
 * can starve the interactive PTY + SFTP channels. Cap in-flight execs per host.
 */
export class ConcurrencyLimiter {
  private active = new Map<string, number>();
  private queue = new Map<string, Array<() => void>>();
  constructor(private max = 4) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if ((this.active.get(key) ?? 0) >= this.max) {
      await new Promise<void>((resolve) => {
        const q = this.queue.get(key) ?? [];
        q.push(resolve);
        this.queue.set(key, q);
      });
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      this.active.set(key, (this.active.get(key) ?? 1) - 1);
      const q = this.queue.get(key);
      const next = q?.shift();
      if (next) next();
    }
  }
}
