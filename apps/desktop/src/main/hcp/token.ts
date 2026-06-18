/**
 * The HCP capability token — a per-install secret both Electron main (which
 * validates every `req`) and the pty daemon (which injects it into spawned
 * agents' env) read from the SAME file under userData, so they always agree
 * without any handshake. 0600 so only the user can read it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Read the token at `<userData>/hcp.token`, creating it on first use. */
export function readOrCreateToken(userDataDir: string): string {
  const file = path.join(userDataDir, "hcp.token");
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch {
    /* missing → create below */
  }
  const token = randomUUID();
  try {
    fs.writeFileSync(file, token, { mode: 0o600 });
  } catch (e) {
    // If the write fails, main and the daemon each mint a DIFFERENT in-memory
    // token → every agent's HCP call silently 401s. Surface it loudly rather
    // than let the control plane look "up" but reject everything.
    console.error(`[hcp] FAILED to persist token at ${file} — HCP auth will mismatch across processes:`, (e as Error).message);
  }
  return token;
}

/** Well-known socket path, derived from userData (both main + daemon agree). */
export function hcpSockPath(userDataDir: string): string {
  return path.join(userDataDir, "hcp.sock");
}
