/** Safe remote command builders; every interpolated path/arg is quoted for the shell ssh runs it in. */
import { shq } from "@hivemind/agents/node";
import { powershellCommand, psq } from "@hivemind/core";
import { windowsFolder } from "@hivemind/core/remote-uri";

/** One argument as a Windows program reads its command line: quoted, a quote in it escaped, and
 *  the backslashes before a quote doubled. */
export function windowsArg(s: string): string {
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** git run by .NET on a Windows machine, its output copied byte for byte: PowerShell's own output
 *  would re-encode it and end its lines in CRLF. */
const WIN_GIT = `$s = New-Object System.Diagnostics.ProcessStartInfo 'git', $a
$s.UseShellExecute = $false; $s.RedirectStandardOutput = $true; $s.RedirectStandardError = $true
$p = [System.Diagnostics.Process]::Start($s)
$e = $p.StandardError.ReadToEndAsync()
$o = [Console]::OpenStandardOutput(); $p.StandardOutput.BaseStream.CopyTo($o); $o.Flush()
$p.WaitForExit(); [Console]::Error.Write($e.Result); exit $p.ExitCode`;

/**
 * Build a safe remote `git -C <path> <args…>` command string. Mirrors the
 * argv arrays the local adapter passes to spawn("git", args, {cwd}); each arg
 * is single-quote-escaped so paths/refs with spaces or metacharacters can't
 * break out of the remote shell.
 */
export function remoteGit(repoPath: string, args: string[], windows = false): string {
  if (windows) return powershellCommand(`$a = ${psq(["-C", windowsFolder(repoPath) ?? repoPath, ...args].map(windowsArg).join(" "))}\n${WIN_GIT}`);
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
