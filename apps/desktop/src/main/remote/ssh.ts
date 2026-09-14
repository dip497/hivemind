/** The system `ssh` for a remote frame (the user's ssh config and keys apply) and the bridge to its PTY daemon. */
import { spawn } from "node:child_process";
import { Duplex, PassThrough } from "node:stream";
import path from "node:path";
import { PROBE, parseProbe, shq, type ProbeResult } from "@hivemind/core";
import type { RemoteTarget } from "../../shared/remote-uri.js";
import { BRIDGE_READY } from "../pty-protocol.js";
import type { HostAuth } from "./conn.js";

export interface SshPaths {
  /** App-owned known_hosts: new host keys are recorded here, never in ~/.ssh. */
  knownHosts: string;
  controlDir?: string;
  askpass?: string;
}
export interface SshCommand {
  args: string[];
  env: Record<string, string>;
}

/** Quoted for ssh's own option parser, which splits values on spaces. */
const sshQuote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** `tty`: allocate a remote terminal (for an interactive session run inside a local PTY). */
export function sshCommand(t: RemoteTarget, auth: HostAuth, paths: SshPaths, remoteCommand: string, opts: { tty?: boolean } = {}): SshCommand {
  const user = auth.username ?? t.user;
  // The target comes from the renderer: nothing in it may read as an ssh option.
  for (const part of [t.host, user ?? ""]) {
    if (part.startsWith("-") || /[\s\x00-\x1f]/.test(part)) throw new Error(`invalid ssh host or user: ${JSON.stringify(part)}`);
  }
  const args = [
    opts.tty ? "-tt" : "-T",
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    // Terminal output compresses well; on for every command because a shared connection keeps the first one's setting.
    "-o", "Compression=yes",
    // Trust on first use, as the in-app connection does; a changed key is refused.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${sshQuote(paths.knownHosts)} ~/.ssh/known_hosts`,
  ];
  if (auth.privateKeyPath) args.push("-i", auth.privateKeyPath);
  if (paths.controlDir) {
    args.push("-o", "ControlMaster=auto", "-o", `ControlPath=${sshQuote(path.join(paths.controlDir, "%C"))}`, "-o", "ControlPersist=60");
  }
  const env: Record<string, string> = {};
  if ((auth.password || auth.passphrase) && paths.askpass) {
    args.push("-o", "NumberOfPasswordPrompts=1");
    env.SSH_ASKPASS = paths.askpass;
    env.SSH_ASKPASS_REQUIRE = "force";
    if (auth.password) env.HIVE_SSH_PASSWORD = auth.password;
    if (auth.passphrase) env.HIVE_SSH_PASSPHRASE = auth.passphrase;
  } else {
    args.push("-o", "BatchMode=yes");
  }
  // No -p for the default port, so a Port in the user's ssh config still applies to an alias.
  if (t.port !== 22) args.push("-p", String(t.port));
  args.push(user ? `${user}@${t.host}` : t.host, remoteCommand);
  return { args, env };
}

/** ssh failures a retry cannot fix: a person has to run `ssh <host>` once. */
export function needsAttention(message: string): boolean {
  return /permission denied|host key verification failed|identification has changed|too many authentication failures|no matching host key|passphrase/i.test(message);
}

/** Answers ssh's prompt from the env of that one ssh process. */
export const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in *assphrase*) printf '%s\\n' "$HIVE_SSH_PASSPHRASE" ;; *) printf '%s\\n' "$HIVE_SSH_PASSWORD" ;; esac
`;

/** The remote side of the bridge, run through a login shell so sessions get the user's PATH. */
export function bridgeRemoteCommand(hivePath: string): string {
  return `exec bash -lc ${shq(`exec ${shq(hivePath)} daemon bridge`)}`;
}

const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

export function probeRemote(cmd: SshCommand, timeoutMs = 30_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", cmd.args, { env: { ...process.env, ...cmd.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("ssh probe timed out")); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 255) return reject(new Error(lastLine(err) || "ssh failed"));
      try { resolve(parseProbe(out)); } catch (e) { reject(e); }
    });
  });
}

export function probeCommand(t: RemoteTarget, auth: HostAuth, paths: SshPaths): SshCommand {
  return sshCommand(t, auth, paths, PROBE);
}

/** Resolves once the remote bridge reports ready; ssh's own error otherwise. Destroying the stream ends ssh. */
export function openBridge(cmd: SshCommand, timeoutMs = 20_000): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", cmd.args, { env: { ...process.env, ...cmd.env }, stdio: ["pipe", "pipe", "pipe"] });
    const readable = new PassThrough();
    const duplex = Duplex.from({ readable, writable: child.stdin });
    let pre = Buffer.alloc(0);
    let ready = false;
    let err = "";
    const fail = (e: Error) => { if (!ready) { ready = true; clearTimeout(timer); child.kill(); reject(e); } };
    const timer = setTimeout(() => fail(new Error("remote bridge did not start in time")), timeoutMs);
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.stdout.on("data", (d: Buffer) => {
      if (ready) { readable.write(d); return; }
      pre = Buffer.concat([pre, d]);
      const at = pre.indexOf(BRIDGE_READY);
      if (at < 0) return;
      ready = true;
      clearTimeout(timer);
      const rest = pre.subarray(at + BRIDGE_READY.length);
      if (rest.length) readable.write(rest);
      resolve(duplex);
    });
    child.on("error", (e) => fail(e));
    child.on("exit", (code) => {
      fail(new Error(lastLine(err) || `ssh exited with ${code}`));
      readable.end();
      duplex.destroy();
    });
    duplex.on("close", () => { if (child.exitCode === null) child.kill(); });
    duplex.on("error", () => { /* surfaced as close */ });
    child.stdin.on("error", () => { /* ssh gone: surfaced as close */ });
    // Never keep main's event loop alive on this child.
    child.unref();
    for (const s of [child.stdin, child.stdout, child.stderr] as unknown as { unref?: () => void }[]) s.unref?.();
  });
}
