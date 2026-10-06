/**
 * This device's network (R16, spec/network-profile.md): the profile it uses, kept in one file,
 * `<data>/network/profile`, holding what hive-net's `--profile` takes: a built-in's name (`local`,
 * which is also what no file means) or a profile its network's admin signed. hive-net
 * verifies profiles, and whether a new one may replace the one in use (an update to a network must
 * come from its admin); this keeps the active one and asks hive-net what it is and whether its
 * servers answer. The app and the `hive` CLI both use it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface NetworkProfile {
  /** "local" for the built-in profile. */
  builtin: "local" | null;
  /** The admin key that signed it; null for a built-in one. */
  admin: string | null;
  profile: {
    v: number;
    name: string;
    relays: { url: string }[];
    lookup: string | null;
    access: { url: string; policy: "open-pow" | "closed" } | null;
    push: { url: string; kinds: string[] } | null;
    admin: string | null;
    local: { mdns: boolean };
    issuedAt: number;
  };
}

/** Whether the network's servers answer this device. */
export interface NetworkHealth {
  /** Each relay, tried alone; one that turned this device away says why. */
  relays: { url: string; ok: boolean; refused?: string }[];
  /** The network's lookup server, when it names one. */
  lookup: { url: string; ok: boolean } | null;
  /** Its access service, when it names one. */
  access: { url: string; ok: boolean } | null;
  mdns: boolean;
}

const BUILTIN = new Set(["local"]);
const LINK = "hivemind://network/";

/** How this device was let onto a network's relays when it was chosen. */
export type Admission = "none needed" | "registered" | "enrolled" | `not admitted: ${string}`;

export class NetworkProfiles {
  constructor(private readonly opts: {
    /** Where the profile is kept (`<data>/network`). */
    dir: string;
    /** hive-net's executable. */
    bin: string;
    /** This device's keys (`<data>/identity`). */
    identity: string;
  }) {}

  get file(): string {
    return path.join(this.opts.dir, "profile");
  }

  /** What hive-net's `--profile` takes for the network in use. */
  arg(): string {
    return fs.existsSync(this.file) ? this.file : "local";
  }

  /** The network in use. */
  active(): Promise<NetworkProfile> {
    return this.verify(this.arg());
  }

  /**
   * Use the network `given` from now on: a built-in's name, a link, a signed profile's text, or
   * the path of a file holding one. Refused (and nothing changes) when it is not a profile to use,
   * or it updates the network in use without its admin's signature.
   */
  async use(given: string): Promise<NetworkProfile & { admission: Admission }> {
    const { content, enrol } = kept(given);
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const next = `${this.file}.${process.pid}.next`;
    fs.writeFileSync(next, `${content}\n`, { mode: 0o600 });
    let verified: NetworkProfile;
    try {
      verified = await this.verify(next, this.arg());
      fs.renameSync(next, this.file);
    } finally {
      fs.rmSync(next, { force: true });
    }
    return { ...verified, admission: await this.admit(verified, enrol) };
  }

  /** Let this device onto `net`'s relays, as its access service allows: registering on an
   *  `open-pow` network, or with the enrolment voucher its link carried on a `closed` one. */
  private async admit(net: NetworkProfile, enrol: unknown): Promise<Admission> {
    const access = net.profile.access;
    if (!access) return "none needed";
    try {
      if (access.policy === "open-pow") {
        await this.register(access.url);
        return "registered";
      }
      if (!enrol) return "not admitted: its admin enrols devices; ask them for an enrolment link";
      await this.redeem(access.url, enrol);
      return "enrolled";
    } catch (e) {
      return `not admitted: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** Whether the network's relays answer this device. */
  async health(): Promise<NetworkHealth> {
    return JSON.parse(await this.run(["doctor", "--identity", this.opts.identity, "--profile", this.arg()])) as NetworkHealth;
  }

  /** A voucher signed by this device: to `visit` a network until `expiresIn` seconds from now, for
   *  `device` (none: whoever redeems it, `uses` times). */
  async voucher(opts: { device?: string; expiresIn: number; uses: number }): Promise<Record<string, unknown>> {
    const args = ["access", "voucher", "--kind", "visit", "--expires-in", String(Math.max(1, Math.round(opts.expiresIn))), "--uses", String(opts.uses), "--identity", this.opts.identity];
    return JSON.parse(await this.run(opts.device ? [...args, "--device", opts.device] : args)) as Record<string, unknown>;
  }

  /** Redeem `voucher` at the access service `access`, as this device. */
  async redeem(access: string, voucher: unknown): Promise<void> {
    await this.run(["access", "redeem", access, JSON.stringify(voucher), "--identity", this.opts.identity]);
  }

  /** Give the access service `access` a voucher that names its device. */
  async vouch(access: string, voucher: unknown): Promise<void> {
    await this.run(["access", "vouch", access, JSON.stringify(voucher)]);
  }

  /** Register this device at the `open-pow` access service `access`. */
  async register(access: string): Promise<void> {
    await this.run(["access", "register", access, "--identity", this.opts.identity]);
  }

  private async verify(given: string, replacing?: string): Promise<NetworkProfile> {
    return JSON.parse(await this.run(["profile", "verify", given, ...(replacing ? ["--replacing", replacing] : [])])) as NetworkProfile;
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.opts.bin, args, { timeout: 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim().replace(/^hive-net: /, "") || err.message));
        else resolve(stdout);
      });
    });
  }
}

/** What is kept for `given`: a built-in's name, or the signed profile's JSON; and the enrolment
 *  voucher a network's link may carry beside it, which is used once and not kept. */
function kept(given: string): { content: string; enrol: unknown } {
  const g = given.trim();
  if (BUILTIN.has(g)) return { content: g, enrol: null };
  const text = g.startsWith(LINK)
    ? Buffer.from(g.slice(LINK.length).replace(/\/$/, ""), "base64url").toString("utf8")
    : g.startsWith("{") ? g : fs.readFileSync(g, "utf8").trim();
  try {
    const file = JSON.parse(text) as { profile?: unknown; signature?: unknown; enrol?: unknown };
    return { content: JSON.stringify({ profile: file.profile, signature: file.signature }), enrol: file.enrol ?? null };
  } catch {
    return { content: text, enrol: null };
  }
}
