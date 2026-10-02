// The person's other devices as one of them keeps them (devices.ts, spec/pairing.md "After" and
// 0.7): a phone another of the person's devices paired with is kept as that device introduced it,
// while it says so; one introduced by two is kept while either does; one this device paired with
// itself is left as it is; anything not the person's phone is not kept; and the list is readable by
// this user alone.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Devices, type PairedDevice } from "../src/devices.ts";
import { certifyDevice, idOf, newSeed } from "../src/identity.ts";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "devices-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const person = newSeed();
const priya = idOf(person);
/** A phone of `of`'s, as an app names it. */
function phone(name: string, of = person) {
  const device = idOf(newSeed());
  return { device, name, kind: "phone" as const, certificate: certifyDevice(of, device), addrs: ["10.0.0.9:4433"], relay: null };
}
const [desk, laptop] = [idOf(newSeed()), idOf(newSeed())];

test("a phone another of the person's devices paired with is kept as that device introduced it, and forgotten once it lists it no more", () => {
  const devices = new Devices(path.join(dir, "devices.json"));
  const pixel = phone("Priya's phone");
  expect(devices.introduce(desk, [pixel], priya, 5)).toEqual([]);
  expect(devices.list()).toEqual([{ ...pixel, pairedAt: 5, via: [desk] }]);
  expect(fs.statSync(path.join(dir, "devices.json")).mode & 0o777).toBe(0o600);
  // Named again, as it is now: kept from when it was first introduced.
  devices.introduce(desk, [{ ...pixel, name: "Pixel", addrs: ["10.0.0.7:4433"] }], priya, 9);
  expect(devices.list()).toEqual([{ ...pixel, name: "Pixel", addrs: ["10.0.0.7:4433"], pairedAt: 5, via: [desk] }]);
  // Listed no more: forgotten.
  expect(devices.introduce(desk, [], priya, 10)).toEqual([pixel.device]);
  expect(devices.list()).toEqual([]);
});

test("a phone introduced by two devices is kept while either lists it; one this device paired with itself is left as it is", () => {
  const devices = new Devices(path.join(dir, "devices.json"));
  const [pixel, own] = [phone("Pixel"), phone("Own")];
  const paired: PairedDevice = { ...own, pairedAt: 1 };
  devices.add(paired);
  devices.introduce(desk, [pixel, own], priya, 2);
  devices.introduce(laptop, [pixel], priya, 3);
  expect(devices.list()).toEqual([paired, { ...pixel, pairedAt: 2, via: [desk, laptop] }]);
  expect(devices.introduce(desk, [], priya, 4)).toEqual([]);
  expect(devices.list()).toEqual([paired, { ...pixel, pairedAt: 2, via: [laptop] }]);
  expect(devices.introduce(laptop, [], priya, 5)).toEqual([pixel.device]);
  expect(devices.list()).toEqual([paired]);
});

test("anything not one of the person's phones is not kept: another person's, a certificate for another device, no name", () => {
  const file = path.join(dir, "devices.json");
  const devices = new Devices(file);
  /** What is kept, as written. */
  const written = (): unknown[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as unknown[] : []);
  const pixel = phone("Pixel");
  const given: unknown[] = [
    phone("Sam's phone", newSeed()),
    { ...pixel, device: idOf(newSeed()) },
    { ...pixel, name: "" },
    { ...pixel, name: "x".repeat(201) },
    { ...pixel, certificate: { ...pixel.certificate, issuedAt: 1 } },
    "a phone",
    null,
  ];
  expect(devices.introduce(desk, given, priya, 1)).toEqual([]);
  expect(written()).toEqual([]);
  // Whatever kind it is said to be, it is kept as a phone.
  devices.introduce(desk, [{ ...pixel, kind: "host" }], priya, 2);
  expect(devices.list().map((d) => d.kind)).toEqual(["phone"]);
});
