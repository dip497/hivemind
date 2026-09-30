/**
 * An invite as a link (design §4.2 A): `hivemind://join/<host device id>#<fragment>`. The fragment
 * (never sent anywhere by a browser) is base64url JSON: the workspace's id, the invite's secret,
 * where the host can be reached, the names to show before joining, and, from a network with an
 * access service (R16, §13.3 D), how the guest's device is let onto its relays: the service, and a
 * voucher the host signed for this invite (none on an `open-pow` network: the device registers). A
 * link is not authorisation: the host checks the secret, once, on `hive/pair/1`.
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
  /** How the guest's device is let onto the host network's relays; null on a network without an
   *  access service. */
  admission: { access: string; voucher: Record<string, unknown> | null } | null;
}

const HEX = (bytes: number) => new RegExp(`^[0-9a-f]{${bytes * 2}}$`);

export function formatJoinLink(link: JoinLink): string {
  const admission = link.admission ? { x: link.admission.access, ...(link.admission.voucher ? { v: link.admission.voucher } : {}) } : {};
  const fragment = Buffer.from(JSON.stringify({ w: link.workspace, s: link.secret, a: link.where.addrs, r: link.where.relay, n: link.names, ...admission }), "utf8").toString("base64url");
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
      admission: typeof f.x === "string" && /^https?:\/\//.test(f.x)
        ? { access: f.x, voucher: f.v && typeof f.v === "object" && !Array.isArray(f.v) ? (f.v as Record<string, unknown>) : null }
        : null,
    };
  } catch {
    return null;
  }
}
