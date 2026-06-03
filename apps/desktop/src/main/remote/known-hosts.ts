/**
 * Trust-on-first-use host-key store. ssh2's default (no hostVerifier) silently
 * accepts ANY host key — never ship that. On first connect we record the host's
 * sha256 key fingerprint; on later connects a MISMATCH is rejected (possible
 * MITM). First use is accepted and stored.
 *
 * Stored as a flat JSON map { hostId: "sha256hex" } at ~/.hivemind-known-hosts.json.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const STORE = join(homedir(), ".hivemind-known-hosts.json");

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(STORE, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function save(map: Record<string, string>): void {
  try {
    writeFileSync(STORE, JSON.stringify(map, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort; a failed write just means we re-prompt-by-trust next time */
  }
}

export type HostKeyVerdict =
  | { ok: true; firstUse: boolean }
  | { ok: false; expected: string; got: string };

/**
 * Verify (and on first use, record) a host's key fingerprint.
 * `keyHashHex` is the sha256 hex string ssh2 passes when hostHash:'sha256' is set.
 */
export function verifyHostKey(hostId: string, keyHashHex: string): HostKeyVerdict {
  const map = load();
  const known = map[hostId];
  if (!known) {
    map[hostId] = keyHashHex;
    save(map);
    return { ok: true, firstUse: true };
  }
  if (known === keyHashHex) return { ok: true, firstUse: false };
  return { ok: false, expected: known, got: keyHashHex };
}

/** Forget a host key (e.g. user re-keyed the server intentionally). */
export function forgetHostKey(hostId: string): void {
  const map = load();
  delete map[hostId];
  save(map);
}
