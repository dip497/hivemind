// A machine's keys (keyring.ts, spec/identity.md): made on first use, the same after a restart,
// its user's alone, and never made anew while the ones there can be read.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineKeys } from "../src/keyring.ts";
import { certificateVerifies, certifyDevice, idOf, newSeed } from "../src/identity.ts";

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keyring-")), "identity"); });
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
const mode = (p: string) => fs.statSync(p).mode & 0o777;

test("a machine's keys are made on first use, are the same after a restart, and are its user's alone", () => {
  const first = machineKeys(dir);
  const again = machineKeys(dir);
  expect([again.deviceId, again.personId]).toEqual([first.deviceId, first.personId]);
  expect(first.deviceId).not.toBe(first.personId);
  expect(certificateVerifies(again.certificate)).toBe(true);
  expect([again.certificate.device, again.certificate.person]).toEqual([first.deviceId, first.personId]);
  expect(again.certificate).toEqual(first.certificate);
  if (process.platform !== "win32") {
    expect(mode(dir)).toBe(0o700);
    for (const f of ["device.key", "person.key", "device.cert"]) expect(mode(path.join(dir, f))).toBe(0o600);
  }
});

test("a certificate that is missing, or not this device's from this person, is made again; the keys stay", () => {
  const keys = machineKeys(dir);
  fs.rmSync(path.join(dir, "device.cert"));
  expect(machineKeys(dir).certificate.device).toBe(keys.deviceId);
  // A certificate someone else signed for this device, or this person signed for another.
  for (const cert of [certifyDevice(newSeed(), keys.deviceId), certifyDevice(keys.person, idOf(newSeed())), "not json"]) {
    fs.writeFileSync(path.join(dir, "device.cert"), typeof cert === "string" ? cert : JSON.stringify(cert));
    const again = machineKeys(dir);
    expect([again.deviceId, again.personId]).toEqual([keys.deviceId, keys.personId]);
    expect([again.certificate.device, again.certificate.person]).toEqual([keys.deviceId, keys.personId]);
    expect(certificateVerifies(again.certificate)).toBe(true);
  }
});

test("a key file that cannot be read as a key is set aside, a new key is made, and that is said", () => {
  const keys = machineKeys(dir);
  fs.writeFileSync(path.join(dir, "device.key"), "not a key\n");
  const warnings: string[] = [];
  const again = machineKeys(dir, (m) => warnings.push(m));
  expect(again.deviceId).not.toBe(keys.deviceId);
  expect(again.personId).toBe(keys.personId);
  expect(warnings).toHaveLength(1);
  const aside = fs.readdirSync(dir).find((f) => f.startsWith("device.key.bad-"));
  expect(aside && fs.readFileSync(path.join(dir, aside), "utf8")).toBe("not a key\n");
  expect(machineKeys(dir).deviceId).toBe(again.deviceId);
});
