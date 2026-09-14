/**
 * Remote command execution for one host at a time, over the system ssh with the
 * app's saved auth (one shared ssh connection per host via ControlMaster). Remote
 * fs and git run through here; interactive PTYs go through remote/pty.ts.
 */
import { spawn } from "node:child_process";
import type { RemoteTarget } from "../../shared/remote-uri.js";
import { RemoteFs, type ExecResult } from "./fs.js";
import { ConcurrencyLimiter } from "./exec.js";
import { sshCommand, type SshPaths } from "./ssh.js";

export interface HostAuth {
  /** Explicit private key path (+ optional passphrase). Agent keys are tried too. */
  privateKeyPath?: string;
  passphrase?: string;
  /** Password auth (when the host has no key set up). Kept in memory only. */
  password?: string;
  /** Override the username parsed from the URI (else uri user, else ssh's default). */
  username?: string;
}

const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

export class RemoteConnectionManager {
  /** Per-host cap so a burst of git calls can't exhaust the server's MaxSessions. */
  readonly limiter = new ConcurrencyLimiter(4);
  /** Auth supplied per host id (a password typed when adding a machine). */
  private auth = new Map<string, HostAuth>();
  /** Keychain-backed fallback for a host not in `auth` — what lets a remote tile
   *  reconnect after an app restart. Injected so this module stays electron-free. */
  private resolveAuth?: (hostId: string) => HostAuth | null;
  private paths?: () => SshPaths;

  setAuth(hostId: string, auth: HostAuth): void {
    this.auth.set(hostId, auth);
  }

  /** Forget a host's in-memory auth (its machine was removed, or the add that supplied it failed). */
  clearAuth(hostId: string): void {
    this.auth.delete(hostId);
  }

  setAuthResolver(fn: (hostId: string) => HostAuth | null): void {
    this.resolveAuth = fn;
  }

  setSshPaths(fn: () => SshPaths): void {
    this.paths = fn;
  }

  /** In-memory auth first, else the keychain resolver, else empty. */
  resolveAuthFor(hostId: string): HostAuth {
    return this.auth.get(hostId) ?? this.resolveAuth?.(hostId) ?? {};
  }

  /** Run one remote shell command; rejects only when ssh itself fails (connect, auth, host key). */
  exec(target: RemoteTarget, cmd: string, opts: { timeoutMs?: number; input?: string | Buffer } = {}): Promise<ExecResult> {
    if (!this.paths) return Promise.reject(new Error("remote ssh is not configured"));
    const c = sshCommand(target, this.resolveAuthFor(target.hostId), this.paths(), cmd);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return this.limiter.run(target.hostId, () => new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("ssh", c.args, { env: { ...process.env, ...c.env }, stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`remote command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-64_000); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 255) return reject(new Error(lastLine(err) || "ssh failed"));
        resolve({ stdout: Buffer.concat(out), stderr: err, code });
      });
      child.stdin.on("error", () => { /* ssh exited first */ });
      child.stdin.end(opts.input ?? "");
    }));
  }

  /** The host's filesystem (stateless: every call is one ssh command). */
  async fs(target: RemoteTarget): Promise<RemoteFs> {
    return new RemoteFs((cmd, input) => this.exec(target, cmd, { input }));
  }
}

/** Process-wide singleton shared by remote PTY, fs, and git. */
export const remoteConns = new RemoteConnectionManager();
