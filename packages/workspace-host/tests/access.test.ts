// A workspace's access list (access.ts, design §6 and §10): a person's devices have the role the
// owner granted them, until it expires or is revoked; the owner's own devices are the owner;
// nothing else gets in, and a grant not signed by the owner counts for nothing.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccessLists, grantBytes } from "../src/access.ts";
import { readDoc, writeDoc } from "../src/doc-file.ts";
import { certifyDevice, idOf, newSeed, newWorkspaceId, signWith } from "../src/identity.ts";

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "access-")), "access"); });
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const owner = newSeed();
const lists = (onWarn?: (m: string) => void) => new AccessLists({ dir, owner, onWarn });
/** A person with a device of theirs: the person's id and the device's certificate. */
function someone() {
  const person = newSeed();
  return { id: idOf(person), cert: certifyDevice(person, idOf(newSeed())), person };
}

test("a person's certified devices have the role granted to them; the owner's are the owner; no one else gets in", () => {
  const ws = newWorkspaceId();
  const a = lists();
  const priya = someone();
  const stranger = someone();
  a.grant(ws, priya.id, "edit");
  expect(a.addDevice(ws, priya.cert)).toBe(true);
  expect(a.accessOf(ws, priya.cert.device)).toBe("edit");
  // A second device of hers, once it shows its certificate.
  const laptop = certifyDevice(priya.person, idOf(newSeed()));
  expect(a.accessOf(ws, laptop.device)).toBeNull();
  a.addDevice(ws, laptop);
  expect(a.accessOf(ws, laptop.device)).toBe("edit");
  // The owner's own device, certified by the owner's key.
  const mine = certifyDevice(owner, idOf(newSeed()));
  a.addDevice(ws, mine);
  expect(a.accessOf(ws, mine.device)).toBe("owner");
  // Someone with no grant: their certificate is not kept, and they have nothing.
  expect(a.addDevice(ws, stranger.cert)).toBe(false);
  expect(a.accessOf(ws, stranger.cert.device)).toBeNull();
  // A certificate that does not verify is not kept.
  expect(a.addDevice(ws, { ...certifyDevice(priya.person, idOf(newSeed())), issuedAt: 1 })).toBe(false);
  // Another workspace of the same owner: nothing carries over.
  expect(a.accessOf(newWorkspaceId(), priya.cert.device)).toBeNull();
  expect(a.people(ws)).toEqual([{ person: priya.id, role: "edit", grantedAt: expect.any(Number), expires: null, devices: [priya.cert.device, laptop.device].sort() }]);
});

test("the list is the same after a restart; a grant changed on disk, or made by someone else, counts for nothing", () => {
  const ws = newWorkspaceId();
  const priya = someone();
  const sam = someone();
  const a = lists();
  a.grant(ws, priya.id, "view");
  a.addDevice(ws, priya.cert);
  a.grant(ws, sam.id, "view");
  a.addDevice(ws, sam.cert);
  expect(lists().accessOf(ws, priya.cert.device)).toBe("view");

  // On disk: Priya's role raised without the owner's key, and a grant Sam signed himself.
  const doc = readDoc(dir, ws, (m) => { throw new Error(m); });
  const grants = doc.getMap("grants");
  grants.set(priya.id, { ...(grants.get(priya.id) as object), role: "agents" });
  const forged = { v: 1, workspace: ws, person: sam.id, role: "agents", grantedAt: Date.now(), expires: null } as const;
  grants.set(sam.id, { ...forged, signature: Buffer.from(signWith(sam.person, grantBytes(forged))).toString("hex") });
  doc.commit();
  writeDoc(dir, ws, doc);

  const warnings: string[] = [];
  const b = lists((m) => warnings.push(m));
  expect(b.accessOf(ws, priya.cert.device)).toBeNull();
  expect(b.accessOf(ws, sam.cert.device)).toBeNull();
  expect(b.people(ws)).toEqual([]);
  expect(warnings.length).toBeGreaterThan(0);
});

test("a revoked person, and one whose grant has expired, gets nothing, on any of their devices", async () => {
  const ws = newWorkspaceId();
  const a = lists();
  const priya = someone();
  const sam = someone();
  a.grant(ws, priya.id, "terminals");
  a.addDevice(ws, priya.cert);
  a.grant(ws, sam.id, "view", Date.now() + 150);
  a.addDevice(ws, sam.cert);
  expect(a.accessOf(ws, sam.cert.device)).toBe("view");

  expect(a.revoke(ws, priya.id)).toBe(true);
  expect(a.accessOf(ws, priya.cert.device)).toBeNull();
  expect(lists().accessOf(ws, priya.cert.device)).toBeNull();
  // Her device is forgotten with her grant: a new grant does not bring it back unseen.
  a.grant(ws, priya.id, "view");
  expect(a.accessOf(ws, priya.cert.device)).toBeNull();

  await Bun.sleep(200);
  expect(a.accessOf(ws, sam.cert.device)).toBeNull();
  expect(a.people(ws).map((p) => p.person)).toEqual([priya.id]);
});

test("what cannot be granted is refused", () => {
  const ws = newWorkspaceId();
  const a = lists();
  const priya = someone();
  expect(() => a.grant(ws, priya.id, "owner" as never)).toThrow(TypeError);
  expect(() => a.grant(ws, idOf(owner), "view")).toThrow(TypeError);
  expect(() => a.grant("not a workspace", priya.id, "view")).toThrow(TypeError);
  expect(() => a.grant(ws, priya.id, "view", Date.now() - 1)).toThrow(TypeError);
  expect(a.people(ws)).toEqual([]);
});
