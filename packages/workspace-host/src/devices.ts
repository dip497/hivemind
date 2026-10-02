/**
 * The person's other devices, as this one knows them (spec/pairing.md, "After"): one entry each,
 * kept in `devices.json` beside this device's keys, written whole and readable by its user alone.
 * An entry whose certificate does not verify is not one of them. A phone that another of the
 * person's devices paired with is one of them here too, as that device introduced it, while it
 * says so (0.7).
 */
import fs from "node:fs";
import path from "node:path";
import { certificateVerifies } from "./identity.js";
import type { PairedWith } from "./pairing.js";

/** One of the person's other devices: who it is, where it was reached, and when it was paired. */
export interface PairedDevice extends PairedWith {
  pairedAt: number;
  /** The devices that introduced it, a phone paired with them: none when it paired with this one. */
  via?: string[];
}

/** The longest name a device is known by. */
const NAME_MAX = 200;

/** A phone of `person`'s, as another of their devices names it; null for anything else. */
function phoneOf(given: unknown, person: string): PairedWith | null {
  const p = given as Partial<PairedWith> | null;
  if (!p || typeof p.device !== "string" || typeof p.name !== "string" || !p.name || p.name.length > NAME_MAX) return null;
  if (!certificateVerifies(p.certificate) || p.certificate.device !== p.device || p.certificate.person !== person) return null;
  const addrs = Array.isArray(p.addrs) ? p.addrs.filter((a): a is string => typeof a === "string") : [];
  return { device: p.device, name: p.name, kind: "phone", certificate: p.certificate, addrs, relay: typeof p.relay === "string" ? p.relay : null };
}

export class Devices {
  constructor(private readonly file: string) {}

  /** The devices kept, whose certificates verify. */
  list(): PairedDevice[] {
    let all: unknown;
    try {
      all = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(all)) return [];
    return all.filter((d): d is PairedDevice => {
      const e = d as Partial<PairedDevice> | null;
      return !!e && typeof e.name === "string" && (e.kind === "app" || e.kind === "host" || e.kind === "phone") && certificateVerifies(e.certificate) && e.certificate.device === e.device
        && (e.via === undefined || (Array.isArray(e.via) && e.via.every((v) => typeof v === "string")));
    });
  }

  /** The phones the device `by` paired with, as it says (`phones`, spec/pairing.md 0.7): each that
   *  is `person`'s is kept as introduced by `by`, at `at` when it is new here, and each that `by`
   *  introduced and lists no more is forgotten, unless another device introduced it too. One that
   *  paired with this device itself is left as it is. The devices forgotten. */
  introduce(by: string, phones: unknown[], person: string, at: number): string[] {
    const listed = new Map<string, PairedWith>();
    for (const given of phones) {
      const phone = phoneOf(given, person);
      if (phone) listed.set(phone.device, phone);
    }
    const before = this.list();
    const forgot: string[] = [];
    const kept: PairedDevice[] = [];
    for (const d of before) {
      const named = listed.get(d.device);
      listed.delete(d.device);
      if (!d.via) {
        kept.push(d);
        continue;
      }
      const others = d.via.filter((v) => v !== by);
      if (named) kept.push({ ...named, pairedAt: d.pairedAt, via: [...others, by] });
      else if (others.length > 0) kept.push({ ...d, via: others });
      else forgot.push(d.device);
    }
    for (const phone of listed.values()) kept.push({ ...phone, pairedAt: at, via: [by] });
    if (JSON.stringify(kept) !== JSON.stringify(before)) this.write(kept);
    return forgot;
  }

  /** Keep `device`, in place of what was kept for it. */
  add(device: PairedDevice): void {
    this.write([...this.list().filter((d) => d.device !== device.device), device]);
  }

  /** Forget `device`; false when it was not kept. */
  remove(device: string): boolean {
    const all = this.list();
    const rest = all.filter((d) => d.device !== device);
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }

  private write(devices: PairedDevice[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(devices, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
