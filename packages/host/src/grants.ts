/**
 * The programs the person lets drive workspaces on this machine (the workspace API's `grant.*`,
 * spec/workspace-api.md "Drive socket"). Each grant names the workspaces it reaches and a role
 * there, as a guest's does; its token is shown once and kept here only as a hash. Only the person
 * makes, lists and takes back grants (`roles.ts` names none of these). Electron-free.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROLES, type Role } from "@hivemind/workspace-host/access";
import type { ClientGrant, NewGrant } from "@hivemind/workspace-api/grants";
import { ApiError, oneOf, text } from "@hivemind/workspace-api/protocol";
import type { Connection, Domain } from "@hivemind/workspace-api/server";

/** What a token starts with, so one pasted somewhere is recognised as ours. */
const PREFIX = "hgr_";
/** The longest name a grant is given. */
const NAME_MAX = 80;

interface Kept extends ClientGrant {
  /** sha256 of the token, hex. */
  hash: string;
}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A folder as it is on disk, links followed; as given when it is not there. */
function real(repo: string): string {
  try {
    return fs.realpathSync(repo);
  } catch {
    return path.resolve(repo);
  }
}

export class Grants {
  private readonly grants: Kept[];
  private readonly revoked = new Set<(id: string) => void>();

  /** `file`: where grants are kept, 0600. */
  constructor(private readonly file: string) {
    this.grants = read(file);
  }

  list(): ClientGrant[] {
    return this.grants.map(shown);
  }

  create(spec: NewGrant): { grant: ClientGrant; token: string } {
    const id = randomBytes(6).toString("hex");
    const token = `${PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
    const kept: Kept = { id, name: spec.name, repos: [...new Set(spec.repos.map(real))], role: spec.role, createdAt: Date.now(), expires: spec.expires ?? null, lastUsed: null, hash: hashOf(token) };
    this.grants.push(kept);
    this.save();
    return { grant: shown(kept), token };
  }

  revoke(id: string): boolean {
    const at = this.grants.findIndex((g) => g.id === id);
    if (at < 0) return false;
    this.grants.splice(at, 1);
    this.save();
    for (const told of this.revoked) told(id);
    return true;
  }

  /** The grant `token` is, while it holds; null for any other token, and once it expired. */
  holder(token: unknown): ClientGrant | null {
    if (typeof token !== "string" || !token.startsWith(PREFIX)) return null;
    const id = token.slice(PREFIX.length, token.indexOf("_", PREFIX.length));
    const kept = this.grants.find((g) => g.id === id);
    if (!kept || !sameHex(kept.hash, hashOf(token)) || !this.live(kept.id)) return null;
    return shown(kept);
  }

  /** Whether grant `id` still holds: not taken back, not expired. */
  live(id: string): boolean {
    const kept = this.grants.find((g) => g.id === id);
    return !!kept && (kept.expires === null || Date.now() < kept.expires);
  }

  /** A program connected with grant `id`. */
  used(id: string): void {
    const kept = this.grants.find((g) => g.id === id);
    if (!kept) return;
    kept.lastUsed = Date.now();
    this.save();
  }

  /** Be told of each grant taken back, until the returned function is called. */
  onRevoked(told: (id: string) => void): () => void {
    this.revoked.add(told);
    return () => { this.revoked.delete(told); };
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, grants: this.grants }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const shown = ({ hash: _hash, ...grant }: Kept): ClientGrant => ({ ...grant, repos: [...grant.repos] });

function read(file: string): Kept[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { v?: unknown; grants?: unknown };
  if (parsed.v !== 1 || !Array.isArray(parsed.grants)) throw new Error(`${file}: not a grants file`);
  return parsed.grants as Kept[];
}

/** Only the person: at a window of theirs, or on one of their own devices. */
const isPerson = (from: Connection): boolean => from.actor.kind === "person" || (from.actor.kind === "peer" && from.actor.access === "owner" && !from.actor.client);

/** `grants`: read when first asked for, so a damaged file fails the call that needs it. */
export function grantsDomain(grants: () => Grants): Domain<"grant.list" | "grant.create" | "grant.revoke"> {
  const person = (from: Connection): void => {
    if (!isPerson(from)) throw new ApiError("FORBIDDEN", "only the person at this machine lets programs drive its workspaces");
  };
  return {
    answers: {
      "grant.list": (from) => {
        person(from);
        return grants().list();
      },
      "grant.create": (from, spec) => {
        person(from);
        const s = (spec ?? {}) as Record<string, unknown>;
        const name = text(s.name, "grant.name").trim();
        if (!name || name.length > NAME_MAX) throw new ApiError("BAD_REQUEST", `grant.name is at most ${NAME_MAX} characters`);
        if (!Array.isArray(s.repos) || s.repos.length === 0) throw new ApiError("BAD_REQUEST", "grant.repos names at least one workspace");
        const repos = s.repos.map((r, i) => text(r, `grant.repos[${i}]`));
        if (!repos.every((r) => path.isAbsolute(r))) throw new ApiError("BAD_REQUEST", "grant.repos are folders, given in full");
        const role: Role = oneOf(s.role, "grant.role", ROLES);
        const expires = s.expires == null ? null : s.expires;
        if (expires !== null && (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires <= Date.now())) {
          throw new ApiError("BAD_REQUEST", "grant.expires is a time to come, in ms since the epoch");
        }
        return grants().create({ name, repos, role, expires });
      },
      "grant.revoke": (from, id) => {
        person(from);
        return { revoked: grants().revoke(text(id, "id")) };
      },
    },
    effects: {
      "grant.create": (spec) => ({ target: typeof (spec as { name?: unknown } | null)?.name === "string" ? (spec as { name: string }).name : undefined, detail: typeof (spec as { role?: unknown } | null)?.role === "string" ? (spec as { role: string }).role : undefined }),
      "grant.revoke": (id) => ({ target: typeof id === "string" ? id : undefined }),
    },
  };
}
