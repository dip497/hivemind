/**
 * Who may reach a workspace (R11; design §6 and §10): its access list, kept by the owner's
 * devices and never shown to anyone else. Each grant gives a person a role in one workspace and
 * is signed by the owner's person key, so a device of the owner's checks it before acting on it
 * (a grant altered on disk, or made by anyone else, is dropped). A person reaches the workspace
 * through their devices, known by the certificates they have shown (spec/identity.md); the
 * owner's own devices, certified by the owner's key, are the owner. The devices the lists let in
 * are what the network gate (hive-net) admits.
 *
 * Each workspace's list is a Loro document of its own (`<dir>`, one file per workspace), so the
 * owner's devices can merge grants made on either (M3).
 */
import { LoroDoc } from "loro-crdt";
import { readDoc, writeDoc } from "./doc-file.js";
import { certificateVerifies, idOf, signWith, verifies, type DeviceCertificate, type Seed } from "./identity.js";

/** Roles (design §6), least to most. The owner is not a role that can be granted. */
export const ROLES = ["view", "edit", "terminals", "agents"] as const;
export type Role = (typeof ROLES)[number];

/** "Person `person` has role `role` in workspace `workspace`", signed by the owner's person key. */
export interface Grant {
  v: 1;
  workspace: string;
  person: string;
  role: Role;
  /** When it was granted, ms since the epoch. */
  grantedAt: number;
  /** When it stops, ms since the epoch; null: never. */
  expires: number | null;
  /** Ed25519 over `grantBytes`, in hex. */
  signature: string;
}

const GRANT_TAG = new TextEncoder().encode("hive/grant/1\n");

/** What a grant signs: its tag, the workspace's id (16 bytes), the person's key, the role's index
 *  in `ROLES`, when it was granted and when it stops (u64, big-endian ms; 0 for never). */
export function grantBytes(g: Pick<Grant, "workspace" | "person" | "role" | "grantedAt" | "expires">): Uint8Array {
  const times = Buffer.alloc(16);
  times.writeBigUInt64BE(BigInt(g.grantedAt), 0);
  times.writeBigUInt64BE(BigInt(g.expires ?? 0), 8);
  return Buffer.concat([GRANT_TAG, Buffer.from(g.workspace, "hex"), Buffer.from(g.person, "hex"), Buffer.from([ROLES.indexOf(g.role)]), times]);
}

const isHex = (v: unknown, bytes: number): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Whether `g` is a grant in `workspace` that `owner` signed. False for anything malformed. */
export function grantVerifies(g: unknown, workspace: string, owner: string): g is Grant {
  if (typeof g !== "object" || g === null) return false;
  const c = g as Partial<Grant>;
  if (c.v !== 1 || c.workspace !== workspace || !isHex(c.workspace, 16) || !isHex(c.person, 32)) return false;
  if (!ROLES.includes(c.role as Role) || !isTime(c.grantedAt) || !(c.expires === null || isTime(c.expires))) return false;
  if (!isHex(c.signature, 64)) return false;
  return verifies(owner, grantBytes(c as Grant), Buffer.from(c.signature, "hex"));
}

/** What a device may do in a workspace: a role, or "owner". */
export type Access = Role | "owner";

/** A person on a workspace's list, as the owner's People panel shows them. */
export interface Person {
  person: string;
  role: Role;
  grantedAt: number;
  expires: number | null;
  /** The ids of the devices they have shown certificates for, sorted. */
  devices: string[];
}

export interface AccessListsOptions {
  /** One file per workspace; created (0700) on the first write. */
  dir: string;
  /** The person key of the owner, whose devices keep these lists and whose key signs them. */
  owner: Seed;
  /** Hears what the embedder should log: a grant dropped, a list set aside. */
  onWarn?: (message: string) => void;
}

/** The access lists of the workspaces this person owns. */
export class AccessLists {
  private readonly docs = new Map<string, LoroDoc>();
  private readonly ownerId: string;

  constructor(private readonly opts: AccessListsOptions) {
    this.ownerId = idOf(opts.owner);
  }

  /** Give `person` `role` in `workspace` (replacing what they had), until `expires` if given. */
  grant(workspace: string, person: string, role: Role, expires: number | null = null): Grant {
    if (!isHex(workspace, 16)) throw new TypeError("access: a workspace is named by its 16-byte id in hex");
    if (!isHex(person, 32)) throw new TypeError("access: a person is named by their public key in hex");
    if (!ROLES.includes(role)) throw new TypeError(`access: ${String(role)} is not a role`);
    if (person === this.ownerId) throw new TypeError("access: the owner has every role already");
    const grantedAt = Date.now();
    if (expires !== null && (!isTime(expires) || expires <= grantedAt)) throw new TypeError("access: a grant expires after it is made");
    const unsigned = { v: 1 as const, workspace, person, role, grantedAt, expires };
    const grant: Grant = { ...unsigned, signature: Buffer.from(signWith(this.opts.owner, grantBytes(unsigned))).toString("hex") };
    this.edit(workspace, (doc) => doc.getMap("grants").set(person, grant));
    return grant;
  }

  /** Take `person` off `workspace`'s list, with the devices they showed. False when they were not on it. */
  revoke(workspace: string, person: string): boolean {
    const doc = this.doc(workspace);
    if (doc.getMap("grants").get(person) === undefined) return false;
    this.edit(workspace, (d) => {
      d.getMap("grants").delete(person);
      const devices = d.getMap("devices");
      for (const [id, cert] of Object.entries(devices.toJSON() as Record<string, DeviceCertificate>)) {
        if (cert.person === person) devices.delete(id);
      }
    });
    return true;
  }

  /** Record a device a person has shown its certificate for. Only a certificate that verifies, of
   *  a person on the list or the owner, is kept; false otherwise. */
  addDevice(workspace: string, cert: unknown): boolean {
    if (!certificateVerifies(cert)) return false;
    if (cert.person !== this.ownerId && !this.grantOf(workspace, cert.person)) return false;
    const known = this.doc(workspace).getMap("devices").get(cert.device) as DeviceCertificate | undefined;
    if (known && known.person === cert.person && known.signature === cert.signature) return true;
    this.edit(workspace, (doc) => doc.getMap("devices").set(cert.device, cert));
    return true;
  }

  /** What the device `device` may do in `workspace` now: the owner's devices are the owner; a
   *  person's are their role until it expires; any other, nothing. */
  accessOf(workspace: string, device: string): Access | null {
    const cert = this.doc(workspace).getMap("devices").get(device) as DeviceCertificate | undefined;
    if (!cert || !certificateVerifies(cert) || cert.device !== device) return null;
    if (cert.person === this.ownerId) return "owner";
    return this.grantOf(workspace, cert.person)?.role ?? null;
  }

  /** The people on `workspace`'s list whose grant holds now. */
  people(workspace: string): Person[] {
    const doc = this.doc(workspace);
    const certs = Object.values(doc.getMap("devices").toJSON() as Record<string, DeviceCertificate>);
    const out: Person[] = [];
    for (const person of Object.keys(doc.getMap("grants").toJSON() as Record<string, unknown>)) {
      const g = this.grantOf(workspace, person);
      if (!g) continue;
      out.push({ person, role: g.role, grantedAt: g.grantedAt, expires: g.expires, devices: certs.filter((c) => c.person === person).map((c) => c.device).sort() });
    }
    return out;
  }

  /** The person's grant in `workspace` if it verifies and holds now. A grant that does not
   *  verify is reported and treated as none. */
  private grantOf(workspace: string, person: string): Grant | null {
    const g: unknown = this.doc(workspace).getMap("grants").get(person);
    if (g === undefined) return null;
    if (!grantVerifies(g, workspace, this.ownerId) || g.person !== person) {
      this.opts.onWarn?.(`a grant to ${person.slice(0, 8)}… in ${workspace} is not the owner's; ignored`);
      return null;
    }
    return g.expires === null || g.expires > Date.now() ? g : null;
  }

  private doc(workspace: string): LoroDoc {
    let doc = this.docs.get(workspace);
    if (!doc) {
      doc = readDoc(this.opts.dir, workspace, (m) => this.opts.onWarn?.(m));
      this.docs.set(workspace, doc);
    }
    return doc;
  }

  private edit(workspace: string, change: (doc: LoroDoc) => void): void {
    const doc = this.doc(workspace);
    change(doc);
    doc.commit();
    writeDoc(this.opts.dir, workspace, doc);
  }
}
