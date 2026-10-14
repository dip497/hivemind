// Revocations owed (revocations.ts, spec/pairing.md 0.9): each host a device unpaired here was a
// guest of is owed word of it once, kept until that host takes it, across a restart.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OwedRevocations } from "../src/revocations.ts";
import { idOf, newSeed, revokeDevice } from "../src/identity.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "revocations-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("each host is owed the word once, until it takes it; what is owed is kept across a restart, readable by this user alone", () => {
  const file = path.join(dir, "identity", "revocations.json");
  const person = newSeed();
  const [laptop, tablet] = [idOf(newSeed()), idOf(newSeed())];
  const [priya, sam] = [idOf(newSeed()), idOf(newSeed())];
  const at = (host: string, workspace: string) => ({ workspace, host, addrs: ["10.0.0.4:4433"], relay: null });
  const owed = new OwedRevocations(file);
  const off = revokeDevice(person, laptop);
  // Two of Priya's workspaces: she is told once.
  owed.add(off, [at(priya, "a".repeat(32)), at(priya, "b".repeat(32)), at(sam, "c".repeat(32))]);
  owed.add(revokeDevice(person, tablet), [at(priya, "a".repeat(32))]);
  const hosts = () => new OwedRevocations(file).list().map((o) => `${o.host.slice(0, 4)} ${o.revocation.device.slice(0, 4)}`).sort();
  expect(hosts()).toEqual([`${priya.slice(0, 4)} ${laptop.slice(0, 4)}`, `${priya.slice(0, 4)} ${tablet.slice(0, 4)}`, `${sam.slice(0, 4)} ${laptop.slice(0, 4)}`].sort());
  expect(new OwedRevocations(file).list().find((o) => o.host === sam)).toEqual({ revocation: off, host: sam, addrs: ["10.0.0.4:4433"], relay: null });
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);

  owed.paid(priya, laptop);
  expect(hosts()).toEqual([`${priya.slice(0, 4)} ${tablet.slice(0, 4)}`, `${sam.slice(0, 4)} ${laptop.slice(0, 4)}`].sort());
});
