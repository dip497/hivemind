// Identity (R3, spec/identity.md), held to conformance/identity.json: vectors made apart from this
// code, with the Rust Ed25519 iroh uses, so the Rust side (hive-net) is held to the same ones.
import { test, expect } from "bun:test";
import { hkdfSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  certificateBytes, certificateVerifies, certifyDevice, idOf, newSeed, newWorkspaceId, signWith, verifies, workspaceSeed,
} from "../src/identity.ts";

interface Vectors {
  ed25519: Array<{ seed: string; id: string; message: string; signature: string }>;
  hkdfSha256: Array<{ ikm: string; salt: string; info: string; length: number; okm: string }>;
  deviceCertificate: Array<{ personSeed: string; person: string; device: string; issuedAt: number; bytes: string; signature: string }>;
  workspaceKey: Array<{ personSeed: string; workspaceId: string; seed: string; id: string }>;
}
const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../conformance/identity.json"), "utf8")) as Vectors;
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("a key's id and signatures are Ed25519's (RFC 8032), and a signature verifies only for its key and message", () => {
  for (const v of vectors.ed25519) {
    expect(idOf(bytes(v.seed))).toBe(v.id);
    expect(hex(signWith(bytes(v.seed), bytes(v.message)))).toBe(v.signature);
    expect(verifies(v.id, bytes(v.message), bytes(v.signature))).toBe(true);
    expect(verifies(v.id, bytes(v.message + "00"), bytes(v.signature))).toBe(false);
  }
  const [a, b] = vectors.ed25519;
  expect(verifies(b!.id, bytes(a!.message), bytes(a!.signature))).toBe(false);
  expect(verifies("not a key", bytes(""), bytes(a!.signature))).toBe(false);
});

test("the HKDF a workspace key is derived with is RFC 5869's HKDF-SHA256", () => {
  for (const v of vectors.hkdfSha256) {
    expect(hex(new Uint8Array(hkdfSync("sha256", bytes(v.ikm), bytes(v.salt), bytes(v.info), v.length)))).toBe(v.okm);
  }
});

test("a device certificate signs the spec's bytes, and verifies; one changed in any field, or signed by another, does not", () => {
  for (const v of vectors.deviceCertificate) {
    expect(hex(certificateBytes(v.person, v.device, v.issuedAt))).toBe(v.bytes);
    const cert = certifyDevice(bytes(v.personSeed), v.device, v.issuedAt);
    expect(cert).toEqual({ v: 1, person: v.person, device: v.device, issuedAt: v.issuedAt, signature: v.signature });
    expect(certificateVerifies(cert)).toBe(true);
    const other = idOf(newSeed());
    const changed: unknown[] = [
      { ...cert, device: other },
      { ...cert, person: other },
      { ...cert, issuedAt: cert.issuedAt + 1 },
      { ...cert, signature: cert.signature.replace(/^./, (c) => (c === "0" ? "1" : "0")) },
      { ...cert, v: 2 },
      { ...certifyDevice(newSeed(), v.device, v.issuedAt), person: v.person }, // signed by someone else
      null, "cert", { ...cert, signature: 7 },
    ];
    for (const c of changed) expect(certificateVerifies(c)).toBe(false);
  }
});

test("a workspace key is the same on every device holding the owner's person key, and no one else's", () => {
  for (const v of vectors.workspaceKey) {
    const seed = workspaceSeed(bytes(v.personSeed), v.workspaceId);
    expect(hex(seed)).toBe(v.seed);
    expect(idOf(seed)).toBe(v.id);
  }
  const [mine, theirs] = vectors.workspaceKey;
  expect(mine!.workspaceId).toBe(theirs!.workspaceId);
  expect(mine!.id).not.toBe(theirs!.id);
  // Another workspace of the same owner has a key of its own.
  expect(idOf(workspaceSeed(bytes(mine!.personSeed), newWorkspaceId()))).not.toBe(mine!.id);
});

test("new keys and workspace ids are random", () => {
  expect(idOf(newSeed())).not.toBe(idOf(newSeed()));
  expect(newWorkspaceId()).toMatch(/^[0-9a-f]{32}$/);
  expect(newWorkspaceId()).not.toBe(newWorkspaceId());
});
