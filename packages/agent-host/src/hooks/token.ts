/**
 * The HCP capability token — a per-install secret both Electron main (which
 * validates every `req`) and the pty daemon read from the SAME file under
 * userData, so they always agree without any handshake. 0600 so only the user
 * can read it. It is the person's: whoever holds it acts as the person at
 * this machine.
 *
 * Each tile's agent is given a token of its own instead (`tileToken`): the
 * tile's id and a MAC of it under the install's token. It names its tile, so
 * the control plane knows which tile calls without being told, and no tile
 * can speak for another with what it was given. It is derived, not stored:
 * a session the daemon restores after a restart gets the same one again.
 * (An agent can read the install's token file like any process of this user;
 * a token of its own makes the actor right, it does not wall the agent off.)
 */
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ipcPath } from "@hivemind/core/ipc";

/** The token a tile's agent is given: `<tile>.<MAC of the tile under the install's token>`. */
export function tileToken(installToken: string, tile: string): string {
  return `${tile}.${createHmac("sha256", installToken).update(tile).digest("base64url")}`;
}

/** Who holds `token`: the person at this machine (the install's own), a tile (the one it was
 *  given), or nobody this install knows. */
export function holderOf(installToken: string, token: unknown): { person: true } | { tile: string } | null {
  if (typeof token !== "string" || !token || !installToken) return null;
  if (same(token, installToken)) return { person: true };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const tile = token.slice(0, dot);
  return same(token, tileToken(installToken, tile)) ? { tile } : null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

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

/** Well-known socket address, derived from userData (both main + daemon agree,
 *  and agent CLIs receive it verbatim as HIVE_HCP_SOCK). A named pipe on
 *  Windows — see ipcPath. */
export function hcpSockPath(userDataDir: string): string {
  return ipcPath(userDataDir, "hcp.sock");
}
