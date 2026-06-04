/**
 * Saved remote connections — so a user doesn't re-type host/user/password every
 * time. Stored at ~/.hivemind-remote-hosts.json. The PASSWORD is encrypted with
 * Electron safeStorage (OS keychain — libsecret/kwallet on Linux, Keychain on
 * macOS) and stored as base64; it is NEVER written in plaintext. If the OS
 * keychain is unavailable, the host is still saved but WITHOUT the password
 * (the user re-enters it on reconnect).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { safeStorage } from "electron";
import { hostIdOf } from "../../shared/remote-uri.js";
import type { HostAuth } from "./conn.js";

const STORE = join(homedir(), ".hivemind-remote-hosts.json");

interface SavedRow {
  hostId: string;
  host: string;
  port: number;
  user: string;
  privateKeyPath?: string;
  /** base64 of safeStorage.encryptString(password) — absent if no/unavailable. */
  encPassword?: string;
}

/** What the renderer sees — never the password itself, just whether one exists. */
export interface SavedHostPublic {
  hostId: string;
  host: string;
  port: number;
  user: string;
  hasPassword: boolean;
  hasKey: boolean;
}

function load(): SavedRow[] {
  try {
    const v = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(v) ? (v as SavedRow[]) : [];
  } catch {
    return [];
  }
}

function persist(rows: SavedRow[]): void {
  try {
    writeFileSync(STORE, JSON.stringify(rows, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

export function listSavedHosts(): SavedHostPublic[] {
  return load().map((r) => ({
    hostId: r.hostId,
    host: r.host,
    port: r.port,
    user: r.user,
    hasPassword: !!r.encPassword,
    hasKey: !!r.privateKeyPath,
  }));
}

/** Upsert a saved host. Encrypts the password via safeStorage when available. */
export function saveHost(host: string, port: number, user: string, auth: HostAuth): void {
  const hostId = hostIdOf(user || null, host, port);
  const rows = load().filter((r) => r.hostId !== hostId);
  const row: SavedRow = { hostId, host, port, user, privateKeyPath: auth.privateKeyPath };
  if (auth.password && safeStorage.isEncryptionAvailable()) {
    row.encPassword = safeStorage.encryptString(auth.password).toString("base64");
  }
  rows.push(row);
  persist(rows);
}

/** Resolve the stored auth (decrypting the password) for a saved host. */
export function savedAuth(hostId: string): { host: string; port: number; user: string; auth: HostAuth } | null {
  const row = load().find((r) => r.hostId === hostId);
  if (!row) return null;
  let password: string | undefined;
  if (row.encPassword && safeStorage.isEncryptionAvailable()) {
    try { password = safeStorage.decryptString(Buffer.from(row.encPassword, "base64")); } catch { /* corrupt — ignore */ }
  }
  return {
    host: row.host,
    port: row.port,
    user: row.user,
    auth: { username: row.user || undefined, privateKeyPath: row.privateKeyPath, password },
  };
}

export function forgetSavedHost(hostId: string): void {
  persist(load().filter((r) => r.hostId !== hostId));
}
