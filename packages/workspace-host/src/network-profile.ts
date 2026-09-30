/**
 * This device's network (R16, spec/network-profile.md): the profile it uses, kept in one file,
 * `<data>/network/profile`, holding what hive-net's `--profile` takes: a built-in's name (`local`,
 * which is also what no file means, or `hosted`) or a profile its network's admin signed. hive-net
 * verifies profiles, and whether a new one may replace the one in use (an update to a network must
 * come from its admin); this keeps the active one and asks hive-net what it is and whether its
 * servers answer. The app and the `hive` CLI both use it.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface NetworkProfile {
  /** "local" or "hosted" for a built-in profile. */
  builtin: "local" | "hosted" | null;
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
  relays: { url: string; ok: boolean }[];
  mdns: boolean;
}

const BUILTIN = new Set(["local", "hosted"]);
const LINK = "hivemind://network/";

export class NetworkProfiles {
  constructor(private readonly opts: {
    /** Where the profile is kept (`<data>/network`). */
    dir: string;
    /** hive-net's executable. */
    bin: string;
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
  async use(given: string): Promise<NetworkProfile> {
    const content = kept(given);
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    const next = `${this.file}.${process.pid}.next`;
    fs.writeFileSync(next, `${content}\n`, { mode: 0o600 });
    try {
      const verified = await this.verify(next, this.arg());
      fs.renameSync(next, this.file);
      return verified;
    } finally {
      fs.rmSync(next, { force: true });
    }
  }

  /** Whether the network's relays answer the device whose keys are in `identity`. */
  async health(identity: string): Promise<NetworkHealth> {
    return JSON.parse(await this.run(["doctor", "--identity", identity, "--profile", this.arg()])) as NetworkHealth;
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

/** What is kept for `given`: a built-in's name, or the signed profile's JSON. */
function kept(given: string): string {
  const g = given.trim();
  if (BUILTIN.has(g)) return g;
  if (g.startsWith(LINK)) return Buffer.from(g.slice(LINK.length).replace(/\/$/, ""), "base64url").toString("utf8");
  if (g.startsWith("{")) return g;
  return fs.readFileSync(g, "utf8").trim();
}
