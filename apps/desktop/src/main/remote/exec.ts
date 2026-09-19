/** Safe remote command builders; every interpolated path/arg is POSIX-quoted because ssh runs a shell string. */
import { shq } from "@hivemind/agents/node";

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
