/**
 * The keys a machine keeps (spec/identity.md, "Where keys are kept"): its device key, the person
 * key it holds and its device certificate, one file each that only its user can read (0600), in
 * a directory only its user can open (0700). Each is made the first time it is needed and never
 * replaced here (pairing replaces the person key and the certificate): a key made anew makes this
 * machine someone new, so it happens only when there is none, or when the file there cannot be
 * read as a key, which is set aside and said. A certificate that does not name this machine's
 * device and person is made again. Two processes making the keys at once keep the same ones: the
 * second finds the first's file and reads it.
 */
import fs from "node:fs";
import path from "node:path";
import { certificateVerifies, certifyDevice, idOf, newSeed, type DeviceCertificate, type Seed } from "./identity.js";

export interface MachineKeys {
  device: Seed;
  person: Seed;
  deviceId: string;
  personId: string;
  /** This device's certificate from the person key it holds. */
  certificate: DeviceCertificate;
}

/** The keys kept in `dir`, made there if they are not. */
export function machineKeys(dir: string, onWarn: (message: string) => void = () => {}): MachineKeys {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const device = seedIn(path.join(dir, "device.key"), onWarn);
  const person = seedIn(path.join(dir, "person.key"), onWarn);
  const deviceId = idOf(device);
  const personId = idOf(person);
  const certFile = path.join(dir, "device.cert");
  let certificate = certificateIn(certFile);
  if (!certificate || certificate.person !== personId || certificate.device !== deviceId) {
    certificate = certifyDevice(person, deviceId);
    replacePrivate(certFile, `${JSON.stringify(certificate)}\n`);
  }
  return { device, person, deviceId, personId, certificate };
}

/**
 * Make `person` the person key kept in `dir`: pairing gave it (spec/pairing.md). The one kept
 * before is set aside as `person.key.<its id>.old`, never deleted, and the device's certificate is
 * made again from the new one. The keys as they are now.
 */
export function adoptPerson(dir: string, person: Seed, onWarn: (message: string) => void = () => {}): MachineKeys {
  const file = path.join(dir, "person.key");
  const before = readIfThere(file)?.trim();
  if (before && /^[0-9a-f]{64}$/.test(before)) {
    const was = idOf(new Uint8Array(Buffer.from(before, "hex")));
    if (was !== idOf(person)) fs.renameSync(file, path.join(dir, `person.key.${was}.old`));
  }
  replacePrivate(file, `${Buffer.from(person).toString("hex")}\n`);
  return machineKeys(dir, onWarn);
}

/** The seed in `file`, or a new one written there when there is none. */
function seedIn(file: string, onWarn: (message: string) => void): Seed {
  for (;;) {
    const text = readIfThere(file);
    if (text !== null) {
      const hex = text.trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return new Uint8Array(Buffer.from(hex, "hex"));
      const aside = `${file}.bad-${Date.now()}`;
      fs.renameSync(file, aside);
      onWarn(`${path.basename(file)} could not be read as a key: set aside as ${path.basename(aside)}, and a new key made`);
    }
    const seed = newSeed();
    try {
      fs.writeFileSync(file, `${Buffer.from(seed).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      return seed;
    } catch (e) {
      // Another process made it between our read and our write: theirs is the key.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}

function certificateIn(file: string): DeviceCertificate | null {
  const text = readIfThere(file);
  if (text === null) return null;
  try {
    const cert: unknown = JSON.parse(text);
    return certificateVerifies(cert) ? cert : null;
  } catch {
    return null;
  }
}

function readIfThere(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Write `file` whole, readable by its user alone, leaving no half-written file behind. */
function replacePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
