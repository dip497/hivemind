/**
 * An invite as a link (design §4.2 A): `hivemind://join/<host device id>#<fragment>`. The fragment
 * (never sent anywhere by a browser) is base64url JSON: the workspace's id, the invite's secret,
 * where the host can be reached, and the names to show before joining. A link is not
 * authorisation: the host checks the secret, once, on `hive/pair/1`.
 */
import type { Where } from "./hive-net.js";

export interface JoinLink {
  /** The host's device id. */
  host: string;
  workspace: string;
  secret: string;
  where: Where;
  /** The workspace's name and the host person's, to show before joining. */
  names: { workspace: string; host: string };
}

const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);

export function formatJoinLink(link: JoinLink): string {
  const fragment = Buffer.from(JSON.stringify({ w: link.workspace, s: link.secret, a: link.where.addrs, r: link.where.relay, n: link.names }), "utf8").toString("base64url");
  return `hivemind://join/${link.host}#${fragment}`;
}

/** The invite `text` is a link to, or null for anything else. */
export function parseJoinLink(text: string): JoinLink | null {
  const m = /^hivemind:\/\/join\/([0-9a-f]{64})#([A-Za-z0-9_-]+)$/.exec(text.trim());
  if (!m) return null;
  try {
    const f = JSON.parse(Buffer.from(m[2]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const names = (f.n ?? {}) as Record<string, unknown>;
    if (typeof f.w !== "string" || !HEX(16).test(f.w) || typeof f.s !== "string" || !HEX(32).test(f.s)) return null;
    const addrs = Array.isArray(f.a) ? f.a.filter((a): a is string => typeof a === "string").slice(0, 16) : [];
    return {
      host: m[1]!,
      workspace: f.w,
      secret: f.s,
      where: { addrs, relay: typeof f.r === "string" ? f.r : null },
      names: { workspace: typeof names.workspace === "string" ? names.workspace.slice(0, 200) : "", host: typeof names.host === "string" ? names.host.slice(0, 64) : "" },
    };
  } catch {
    return null;
  }
}
