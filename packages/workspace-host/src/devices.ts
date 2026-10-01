/**
 * The person's other devices, as this one knows them (spec/pairing.md, "After"): one entry each,
 * kept in `devices.json` beside this device's keys, written whole and readable by its user alone.
 * An entry whose certificate does not verify is not one of them.
 */
import fs from "node:fs";
import path from "node:path";
import { certificateVerifies } from "./identity.js";
import type { PairedWith } from "./pairing.js";

/** One of the person's other devices: who it is, where it was reached, and when it was paired. */
export interface PairedDevice extends PairedWith {
  pairedAt: number;
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
      return !!e && typeof e.name === "string" && (e.kind === "app" || e.kind === "host") && certificateVerifies(e.certificate) && e.certificate.device === e.device;
    });
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
