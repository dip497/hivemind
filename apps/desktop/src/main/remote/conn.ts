/**
 * RemoteConnectionManager — one pooled ssh2.Client per host. SSH multiplexes
 * channels, so a single connection carries the interactive PTY(s), one cached
 * SFTP session, and all git execs. Auth: SSH agent first, then an explicit
 * private-key file. Host keys are TOFU-verified (known-hosts.ts).
 */
import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import { parseRemote, type RemoteTarget } from "../../shared/remote-uri.js";
import { RemoteFs } from "./fs.js";
import { ConcurrencyLimiter } from "./exec.js";
import { verifyHostKey } from "./known-hosts.js";

export interface HostAuth {
  /** Explicit private key path (+ optional passphrase). Agent is tried first. */
  privateKeyPath?: string;
  passphrase?: string;
  /** Password auth (when the host has no key set up). Kept in memory only. */
  password?: string;
  /** Override the username parsed from the URI (else uri user, else $USER). */
  username?: string;
}

interface Pooled {
  client: Client;
  ready: Promise<void>;
  fs?: Promise<RemoteFs>;
}

export class RemoteConnectionManager {
  private pool = new Map<string, Pooled>();
  /** Per-host git-exec concurrency cap so execs don't starve PTY/SFTP channels. */
  readonly limiter = new ConcurrencyLimiter(4);
  /** Auth config supplied per host id (set by sshConnect before first use). */
  private auth = new Map<string, HostAuth>();

  setAuth(hostId: string, auth: HostAuth): void {
    this.auth.set(hostId, auth);
  }

  /** Connect (or reuse) the Client for a remote target's host. */
  async get(target: RemoteTarget): Promise<Client> {
    const existing = this.pool.get(target.hostId);
    if (existing) {
      await existing.ready;
      return existing.client;
    }
    const auth = this.auth.get(target.hostId) ?? {};
    const username =
      auth.username ?? target.user ?? process.env.USER ?? process.env.USERNAME ?? "root";

    const client = new Client();
    const ready = new Promise<void>((resolve, reject) => {
      client.once("ready", () => resolve());
      client.once("error", (e) => reject(e));
    });

    const entry: Pooled = { client, ready };
    this.pool.set(target.hostId, entry);
    client.on("close", () => this.pool.delete(target.hostId));
    client.on("error", () => this.pool.delete(target.hostId));

    // Some servers do password auth via keyboard-interactive, not the `password`
    // method — answer those prompts with the supplied password.
    if (auth.password) {
      client.on("keyboard-interactive", (_n, _i, _l, _prompts, finish) =>
        finish([auth.password as string]),
      );
    }
    client.connect({
      host: target.host,
      port: target.port,
      username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Only offer the agent when no password was given (else ssh2 tries agent
      // keys first and may fail before reaching password on key-only setups).
      ...(auth.password ? {} : { agent: process.env.SSH_AUTH_SOCK }),
      ...(auth.privateKeyPath
        ? { privateKey: readFileSync(auth.privateKeyPath), passphrase: auth.passphrase }
        : {}),
      ...(auth.password ? { password: auth.password, tryKeyboard: true } : {}),
      hostHash: "sha256",
      // TOFU: accept+record on first use, reject on later mismatch.
      hostVerifier: (keyHashHex: string) => {
        const v = verifyHostKey(target.hostId, keyHashHex);
        return v.ok;
      },
    });

    try {
      await ready;
    } catch (e) {
      this.pool.delete(target.hostId);
      throw e;
    }
    return client;
  }

  /** The cached single SFTP session for a host (opened lazily, reused). */
  async fs(target: RemoteTarget): Promise<RemoteFs> {
    const client = await this.get(target);
    const entry = this.pool.get(target.hostId)!;
    if (!entry.fs) entry.fs = RemoteFs.open(client);
    return entry.fs;
  }

  /** Connect from a uri string + auth, returning the resolved home dir (a cheap
   *  connectivity probe used by the "attach remote" flow). */
  async probe(uri: string, auth: HostAuth): Promise<{ home: string; hostId: string }> {
    const target = parseRemote(uri);
    this.setAuth(target.hostId, auth);
    const fs = await this.fs(target);
    const home = await fs.home();
    return { home, hostId: target.hostId };
  }

  end(hostId: string): void {
    this.pool.get(hostId)?.client.end();
    this.pool.delete(hostId);
  }

  endAll(): void {
    for (const id of Array.from(this.pool.keys())) this.end(id);
  }
}

/** Process-wide singleton (one pool shared by remote PTY, fs, and git). */
export const remoteConns = new RemoteConnectionManager();
