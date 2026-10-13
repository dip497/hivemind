/**
 * The word a device unpaired here is the person's no more, owed to each host it was a guest of
 * (spec/pairing.md 0.9): one entry a host and device, kept in a file readable by this user alone
 * until that host takes it, so a host away when the device was unpaired is told once it is back.
 */
import fs from "node:fs";
import path from "node:path";
import type { GuestOf } from "./devices.js";
import { revocationVerifies, type DeviceRevocation } from "./identity.js";

export interface Owed {
  revocation: DeviceRevocation;
  host: string;
  addrs: string[];
  relay: string | null;
}

export class OwedRevocations {
  constructor(private readonly file: string) {}

  list(): Owed[] {
    let all: unknown;
    try {
      all = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return [];
    }
    return Array.isArray(all) ? all.filter((o): o is Owed => !!o && typeof o.host === "string" && revocationVerifies(o.revocation)) : [];
  }

  /** Owe `revocation` to each host of `guestOf`, once a host. */
  add(revocation: DeviceRevocation, guestOf: GuestOf[]): void {
    const all = this.list();
    for (const g of guestOf) {
      if (all.some((o) => o.host === g.host && o.revocation.device === revocation.device)) continue;
      all.push({ revocation, host: g.host, addrs: g.addrs, relay: g.relay });
    }
    this.write(all);
  }

  /** `host` took the word of `device`. */
  paid(host: string, device: string): void {
    this.write(this.list().filter((o) => o.host !== host || o.revocation.device !== device));
  }

  private write(owed: Owed[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(owed, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
