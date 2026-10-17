/**
 * Who the browser server lets in (docs/design/browser-app-2026-10-13.md §6): the token minted for
 * this launch, the cookie it is traded for, and the Host and Origin a request may carry.
 * Electron-free.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Names a request's Host may carry besides the ones the person configured. */
const LOOPBACK = ["127.0.0.1", "localhost"];

export const mintToken = (): string => randomBytes(32).toString("base64url");

/** What opens a view's files and nothing else (§11): a sandboxed frame's requests carry no cookie. */
export const viewsKey = (token: string): string => createHmac("sha256", token).update("hm-view").digest("base64url");

/** Constant time, whatever the lengths. */
export function sameToken(given: string, token: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

/** The host part of a Host header, lowercased, without its port. */
function hostname(host: string): string {
  const bracketed = /^\[([^\]]*)\]/.exec(host);
  return (bracketed ? bracketed[1]! : host.replace(/:\d*$/, "")).toLowerCase();
}

/** Against DNS rebinding: the request names this machine, or a name the person gave it. */
export function hostAllowed(host: string | undefined, names: readonly string[]): boolean {
  if (!host) return false;
  const name = hostname(host);
  return LOOPBACK.includes(name) || names.some((n) => hostname(n) === name);
}

/** The page asking is this server's own: its Origin names the host the request was sent to. */
export function sameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Cookies are not kept apart by port, so the name carries it. */
export const cookieName = (port: number): string => `hive-${port}`;

export function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

export const sessionCookie = (port: number, token: string, secure: boolean): string =>
  `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
