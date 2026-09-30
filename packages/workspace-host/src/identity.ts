/**
 * Identity (docs/design/multiplayer-2026-09-28.md, R3; spec/identity.md): the keys that say who a
 * device, a person and a workspace are. All are Ed25519, kept as their 32-byte seed and named by
 * their public key in lowercase hex (a device's is its iroh `EndpointId`).
 *
 * - A **device key** is made once per machine.
 * - A **person key** is made on a person's first device and copied to their others when they pair
 *   them; it signs a **device certificate** for each ("device D is person P's").
 * - A **workspace key** is derived from its owner's person key and the workspace's id, so every one
 *   of the owner's devices derives the same one and nobody else can; it signs where the workspace
 *   is hosted.
 *
 * Node-free of Electron; the formats are the spec's, which the Rust side (hive-net, R10) follows
 * too, held to the vectors in `conformance/identity.json`.
 */
import { createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";

/** A key's secret: its 32-byte Ed25519 seed. */
export type Seed = Uint8Array;

/** PKCS#8 DER for an Ed25519 key is this prefix, then the seed. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI DER for an Ed25519 public key is this prefix, then the key. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const isHexKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** A new key: 32 random bytes. */
export function newSeed(): Seed {
  return new Uint8Array(randomBytes(32));
}

function privateKey(seed: Seed) {
  if (seed.length !== 32) throw new TypeError("identity: a seed is 32 bytes");
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

/** The public key of `seed`, in lowercase hex: the id of whatever it is the key of. */
export function idOf(seed: Seed): string {
  const der = createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" });
  return hex(der.subarray(der.length - 32));
}

export function signWith(seed: Seed, message: Uint8Array): Uint8Array {
  return new Uint8Array(edSign(null, message, privateKey(seed)));
}

/** Whether `signature` is `id`'s over `message`. False for anything malformed. */
export function verifies(id: string, message: Uint8Array, signature: Uint8Array): boolean {
  if (!isHexKey(id) || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(id, "hex")]), format: "der", type: "spki" });
    return edVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

// ── device certificates ─────────────────────────────────────────────────────

/** "Device `device` is person `person`'s", signed by the person key. */
export interface DeviceCertificate {
  v: 1;
  person: string;
  device: string;
  /** When it was signed, ms since the epoch. */
  issuedAt: number;
  /** Ed25519 over `certificateBytes`, in hex. */
  signature: string;
}

const CERT_TAG = new TextEncoder().encode("hive/device-certificate/1\n");

/** What a device certificate signs: its tag, the person's key, the device's key, and when (u64,
 *  big-endian ms). */
export function certificateBytes(person: string, device: string, issuedAt: number): Uint8Array {
  const when = Buffer.alloc(8);
  when.writeBigUInt64BE(BigInt(issuedAt));
  return Buffer.concat([CERT_TAG, Buffer.from(person, "hex"), Buffer.from(device, "hex"), when]);
}

/** Certify that `device` is the person's whose key `personSeed` is. */
export function certifyDevice(personSeed: Seed, device: string, issuedAt: number = Date.now()): DeviceCertificate {
  if (!isHexKey(device)) throw new TypeError("identity: a device is named by its public key in hex");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new TypeError("identity: issuedAt is ms since the epoch");
  const person = idOf(personSeed);
  return { v: 1, person, device, issuedAt, signature: hex(signWith(personSeed, certificateBytes(person, device, issuedAt))) };
}

/** Whether `cert` is a device certificate its person signed. False for anything malformed. */
export function certificateVerifies(cert: unknown): cert is DeviceCertificate {
  if (typeof cert !== "object" || cert === null) return false;
  const c = cert as Partial<DeviceCertificate>;
  if (c.v !== 1 || !isHexKey(c.person) || !isHexKey(c.device)) return false;
  if (typeof c.issuedAt !== "number" || !Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) return false;
  if (typeof c.signature !== "string" || !/^[0-9a-f]{128}$/.test(c.signature)) return false;
  return verifies(c.person, certificateBytes(c.person, c.device, c.issuedAt), Buffer.from(c.signature, "hex"));
}

// ── workspaces ──────────────────────────────────────────────────────────────

/** A new workspace's id: 16 random bytes, in hex. */
export function newWorkspaceId(): string {
  return hex(randomBytes(16));
}

/** The workspace key of workspace `workspaceId` owned by the person whose key `personSeed` is:
 *  HKDF-SHA256 of the person's seed, with no salt and the info `hive-workspace` followed by the
 *  workspace's id. Every device holding the person key derives the same; no one else can. */
export function workspaceSeed(personSeed: Seed, workspaceId: string): Seed {
  if (personSeed.length !== 32) throw new TypeError("identity: a seed is 32 bytes");
  if (typeof workspaceId !== "string" || !workspaceId) throw new TypeError("identity: a workspace id is text");
  const info = Buffer.concat([Buffer.from("hive-workspace"), Buffer.from(workspaceId, "utf8")]);
  return new Uint8Array(hkdfSync("sha256", personSeed, new Uint8Array(0), info, 32));
}
